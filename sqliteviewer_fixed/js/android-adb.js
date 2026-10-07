/*
 * Android (ADB over WebUSB) live database viewer.
 *
 * Reads the databases of a *debuggable* app with `adb shell run-as <package>`,
 * merges the SQLite write-ahead log so recent writes are visible, and hands the
 * result to the main app (openAdbDatabase / refreshActiveDatabaseBytes in main.js).
 * Everything happens in the browser; nothing is uploaded.
 */
(function () {
    "use strict";

    var LIBS = {
        adb: "https://esm.sh/@yume-chan/adb@2.6.4",
        usb: "https://esm.sh/@yume-chan/adb-daemon-webusb@2.3.2?deps=@yume-chan/adb@2.6.4",
        credential: "https://esm.sh/@yume-chan/adb-credential-web@2.1.0?deps=@yume-chan/adb@2.6.4"
    };

    var SAFE_NAME = /^[A-Za-z0-9._-]+$/;
    var SQLITE_MAGIC = "SQLite format 3\u0000";
    var PULL_ATTEMPTS = 3;
    var PULL_TIMEOUT_MS = 30000;
    var BACKGROUND_MIN_INTERVAL_MS = 10000;

    var libs = null;
    var adb = null;
    var device = null;
    var bound = false;
    var modeRestored = false;
    var pulling = false;
    var autoTimer = null;
    var lastBytes = null;
    var current = null; // { sessionId, packageName, databaseName }
    var decoder = new TextDecoder();

    function $(id) {
        return document.getElementById(id);
    }

    /* ---- SQLite WAL merge ------------------------------------------------- */

    function readPageSize(bytes) {
        var size = (bytes[16] << 8) | bytes[17];
        return size === 1 ? 65536 : size;
    }

    function walChecksum(view, offset, length, bigEndian, s0, s1) {
        for (var i = 0; i < length; i += 8) {
            var x0 = view.getUint32(offset + i, !bigEndian);
            var x1 = view.getUint32(offset + i + 4, !bigEndian);
            s0 = (s0 + x0 + s1) >>> 0;
            s1 = (s1 + x1 + s0) >>> 0;
        }
        return [s0, s1];
    }

    // Applies the committed frames of a WAL file on top of the main database file.
    function applyWal(dbBytes, walBytes) {
        if (!walBytes || walBytes.length < 32) return { bytes: dbBytes, frames: 0 };

        var pageSize = readPageSize(dbBytes);
        var view = new DataView(walBytes.buffer, walBytes.byteOffset, walBytes.byteLength);
        var magic = view.getUint32(0);
        if (magic !== 0x377f0682 && magic !== 0x377f0683) return { bytes: dbBytes, frames: 0 };

        var bigEndian = magic === 0x377f0683;
        if (view.getUint32(8) !== pageSize) return { bytes: dbBytes, frames: 0 };

        var salt1 = view.getUint32(16);
        var salt2 = view.getUint32(20);
        var sums = walChecksum(view, 0, 24, bigEndian, 0, 0);
        if (sums[0] !== view.getUint32(24) || sums[1] !== view.getUint32(28)) {
            return { bytes: dbBytes, frames: 0 };
        }

        var frameSize = 24 + pageSize;
        var offset = 32;
        var pending = [];
        var committed = [];
        var pageCount = 0;

        while (offset + frameSize <= walBytes.length) {
            var pageNumber = view.getUint32(offset);
            var commitSize = view.getUint32(offset + 4);

            if (pageNumber === 0) break;
            if (view.getUint32(offset + 8) !== salt1 || view.getUint32(offset + 12) !== salt2) break;

            sums = walChecksum(view, offset, 8, bigEndian, sums[0], sums[1]);
            sums = walChecksum(view, offset + 24, pageSize, bigEndian, sums[0], sums[1]);
            if (sums[0] !== view.getUint32(offset + 16) || sums[1] !== view.getUint32(offset + 20)) break;

            pending.push({ page: pageNumber, offset: offset + 24 });

            if (commitSize !== 0) {
                committed = committed.concat(pending);
                pending = [];
                pageCount = commitSize;
            }

            offset += frameSize;
        }

        if (committed.length === 0 || pageCount === 0) return { bytes: dbBytes, frames: 0 };

        var merged = new Uint8Array(pageCount * pageSize);
        merged.set(dbBytes.subarray(0, Math.min(dbBytes.length, merged.length)));

        committed.forEach(function (frame) {
            if (frame.page > pageCount) return;
            merged.set(walBytes.subarray(frame.offset, frame.offset + pageSize), (frame.page - 1) * pageSize);
        });

        return { bytes: merged, frames: committed.length };
    }

    /* ---- Pulling a database ---------------------------------------------- */

    function isSqlite(bytes) {
        if (bytes.length < 100) return false;
        for (var i = 0; i < SQLITE_MAGIC.length; i++) {
            if (bytes[i] !== SQLITE_MAGIC.charCodeAt(i)) return false;
        }
        var pageSize = readPageSize(bytes);
        return pageSize >= 512 && bytes.length % pageSize === 0;
    }

    function decodeBase64(text) {
        var binary = atob(text.replace(/\s+/g, ""));
        var out = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    }

    // Output layout: "<db size> <wal size>\n" + db bytes + wal bytes. The total length
    // must match exactly, which detects mangled line endings and files that changed
    // while they were being copied.
    function splitPullOutput(stdout) {
        var newline = -1;
        for (var i = 0; i < Math.min(stdout.length, 64); i++) {
            if (stdout[i] === 10) { newline = i; break; }
        }
        if (newline < 1) throw new Error("Unexpected output from the device.");

        var sizes = /^\s*(\d+)\s+(\d+)/.exec(decoder.decode(stdout.subarray(0, newline)));
        if (!sizes) throw new Error("Unexpected output from the device.");

        var dbSize = parseInt(sizes[1], 10);
        var walSize = parseInt(sizes[2], 10);
        var body = stdout.subarray(newline + 1);
        if (!(dbSize > 0) || body.length !== dbSize + walSize) {
            throw new Error("The copy was incomplete or the database changed while it was being copied.");
        }

        return { db: body.slice(0, dbSize), wal: body.slice(dbSize) };
    }

    async function runShell(command) {
        var subprocess = adb.subprocess;

        if (subprocess.shellProtocol) {
            var result = await subprocess.shellProtocol.spawnWait(command);
            return { stdout: result.stdout, stderr: decoder.decode(result.stderr || new Uint8Array(0)), code: result.exitCode };
        }

        var output = await subprocess.noneProtocol.spawnWait(command);
        return { stdout: output, stderr: "", code: 0 };
    }

    async function runShellText(command) {
        var result = await runShell(command);
        return { text: decoder.decode(result.stdout), stderr: result.stderr, code: result.code };
    }

    function assertSafe(name, label) {
        if (!SAFE_NAME.test(name)) throw new Error(label + " contains unsupported characters: " + name);
    }

    async function pullDatabase(packageName, databaseName) {
        assertSafe(packageName, "Package name");
        assertSafe(databaseName, "Database name");

        var path = "databases/" + databaseName;
        var script = "S=$(wc -c < " + path + "); W=$(wc -c < " + path + "-wal 2>/dev/null || echo 0); " +
            "echo $S $W; cat " + path + " " + path + "-wal 2>/dev/null";
        var lastError = null;

        for (var attempt = 0; attempt < PULL_ATTEMPTS; attempt++) {
            // The first attempts use the raw stream; a final attempt uses base64
            // in case the device mangles binary output.
            var useBase64 = attempt === PULL_ATTEMPTS - 1;
            var command = "run-as " + packageName + " sh -c '" +
                (useBase64 ? "(" + script + ") | base64" : script) + "'";

            try {
                var result = await runShell(command);
                var stdout = result.stdout;

                if (stdout.length === 0) {
                    throw new Error(result.stderr.trim() || "No data was returned. Is the app debuggable?");
                }

                if (useBase64) stdout = decodeBase64(decoder.decode(stdout));

                var parts = splitPullOutput(stdout);
                if (!isSqlite(parts.db)) throw new Error("The copied file is not a valid SQLite database.");

                var merged = applyWal(parts.db, parts.wal);
                return { bytes: merged.bytes, walFrames: merged.frames };
            } catch (error) {
                lastError = error;
            }
        }

        throw lastError || new Error("Could not copy the database.");
    }

    /* ---- Device discovery -------------------------------------------------- */

    async function listDebuggablePackages() {
        var command = "for p in $(pm list packages -3); do p=${p#package:}; " +
            "run-as $p ls databases >/dev/null 2>&1 && echo $p; done";
        var result = await runShellText(command);

        return result.text.split(/\r?\n/).map(function (line) {
            return line.trim();
        }).filter(function (line) {
            return SAFE_NAME.test(line);
        }).sort();
    }

    async function listDatabases(packageName) {
        assertSafe(packageName, "Package name");
        var result = await runShellText("run-as " + packageName + " ls -1 databases");

        return result.text.split(/\r?\n/).map(function (line) {
            return line.trim();
        }).filter(function (name) {
            return SAFE_NAME.test(name) && !/-(wal|shm|journal)$/.test(name);
        }).sort();
    }

    /* ---- UI helpers ---------------------------------------------------------- */

    function setStatus(text, kind) {
        var el = $("android_status");
        if (!el) return;
        el.textContent = text || "";
        el.className = "android-status" + (kind ? " is-" + kind : "");
    }

    function fillSelect(select, values, emptyText) {
        select.innerHTML = "";

        if (values.length === 0) {
            var empty = document.createElement("option");
            empty.value = "";
            empty.textContent = emptyText;
            select.appendChild(empty);
            select.disabled = true;
            return;
        }

        values.forEach(function (value) {
            var option = document.createElement("option");
            option.value = value;
            option.textContent = value;
            select.appendChild(option);
        });
        select.disabled = false;
    }

    // Shows a shimmer skeleton in place of the app / database lists while they load.
    function setPickerLoading(on, onlyDatabase) {
        var picker = $("android_picker");
        if (!picker) return;

        Array.prototype.forEach.call(picker.querySelectorAll(".android-field"), function (field, index) {
            field.classList.toggle("is-loading", on && (!onlyDatabase || index === 1));
        });

        picker.setAttribute("aria-busy", on ? "true" : "false");

        // "Open database" is available exactly when an app and a database are selected.
        $("android_load").disabled = on || !($("android_package").value && $("android_database").value);
        if (!on) refreshOptions();
    }

    function setConnectedUi(connected) {
        $("android_connect").style.display = connected ? "none" : "";
        $("android_disconnect").style.display = connected ? "" : "none";
        $("android_picker").style.display = connected ? "" : "none";
        setPickerLoading(connected);
        $("android_mode_box").style.display = connected ? "none" : "";
        if (connected) {
            $("android_server_box").style.display = "none";
        } else {
            updateModeUi();
        }
    }

    // Called when a database is opened (true) or the phone is disconnected (false).
    function setLiveControls(enabled) {
        if (!enabled) {
            $("android_auto").checked = false;
            $("android_live_edit").checked = false;
            live.enabled = false;
            helperCache = {};
            stopAutoRefresh();
            setChip("", "");
            setLiveChip(false);
        }

        refreshOptions();
    }

    // Small status chip in the toolbar so the live state is visible with the dialog closed.
    // One toolbar button shows everything: the Android panel link, auto-refresh and live-edit state.
    var buttonState = { auto: null, edit: null };

    function renderLiveButton(flash) {
        var button = $("android_open_btn");
        var label = $("android_open_text");
        if (!button || !label) return;

        var rank = { ok: 1, warn: 2, error: 3 };
        var parts = ["Live Android"];
        var kind = null;

        // Live status belongs to the phone's database tab. On any other tab the button stays plain.
        var onPhoneTab = !!(adb && current && activeDatabaseSessionId === current.sessionId);

        if (onPhoneTab && buttonState.auto) {
            parts.push(buttonState.auto.text.replace(/^LIVE\s*·\s*/, "").replace(/^LIVE paused/, "paused"));
            kind = buttonState.auto.kind;
        }

        if (onPhoneTab && buttonState.edit) {
            var detail = buttonState.edit.text.replace(/^LIVE EDIT\s*·?\s*/, "");
            parts.push(detail ? "edit " + detail : "edit on");
            if (!kind || rank[buttonState.edit.kind] > rank[kind]) kind = buttonState.edit.kind;
        }

        label.textContent = parts.join(" · ");
        button.className = "toolbar-btn" + (kind ? " live-chip is-" + kind : "") + (flash ? " is-flash" : "");
        button.title = kind
            ? "Live Android: " + parts.slice(1).join(" · ") + ". Click to open the Android panel."
            : "Live debug an Android app database over USB";

        if (flash) {
            setTimeout(function () { button.classList.remove("is-flash"); }, 1500);
        }
    }

    function setChip(text, kind, flash) {
        buttonState.auto = (!text || !$("android_auto").checked) ? null : { text: text, kind: kind || "ok" };
        renderLiveButton(flash);
    }

    function withTimeout(promise, ms, message) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () { reject(new Error(message)); }, ms);
            promise.then(function (value) { clearTimeout(timer); resolve(value); },
                function (error) { clearTimeout(timer); reject(error); });
        });
    }

    function timeText() {
        return new Date().toLocaleTimeString();
    }

    function sameBytes(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) {
            if (a[i] !== b[i]) return false;
        }
        return true;
    }

    /* ---- Connect / disconnect -------------------------------------------------- */

    async function loadLibraries() {
        if (libs) return libs;

        setStatus("Loading the ADB library...");
        var loaded = await Promise.all([import(LIBS.adb), import(LIBS.usb), import(LIBS.credential)]);
        libs = { adb: loaded[0], usb: loaded[1], credential: loaded[2] };
        return libs;
    }

    async function loadApps() {
        try {
            setStatus("Scanning for debuggable apps...");
            var packages = await listDebuggablePackages();
            fillSelect($("android_package"), packages, "No debuggable apps found");
            $("android_load").disabled = packages.length === 0;

            if (packages.length === 0) {
                fillSelect($("android_database"), [], "-");
                setStatus("Connected, but no debuggable app with databases was found. Install a debug build of your app and open it once.", "error");
                return;
            }

            setStatus("Connected. Choose an app and a database.", "ok");
            await loadDatabases();
    
        } finally {
            setPickerLoading(false);
        }
    }

    async function loadDatabases() {
        setPickerLoading(true, true);

        try {
            var packageName = $("android_package").value;
            if (!packageName) return;

            setStatus("Reading databases of " + packageName + "...");
            var databases = await listDatabases(packageName);
            fillSelect($("android_database"), databases, "No databases found");
            $("android_load").disabled = databases.length === 0;
            setStatus(databases.length ? "Connected. Choose an app and a database." : "This app has no databases yet.",
                databases.length ? "ok" : "error");

            refreshOptions();
            checkHelperFor(packageName);
    
        } finally {
            setPickerLoading(false);
        }
    }

    async function connectUsb() {
        $("android_connect").disabled = true;

        try {
            if (!navigator.usb) throw new Error("WebUSB is not available. Use Chrome or Edge on desktop over HTTPS.");

            var lib = await loadLibraries();
            var manager = lib.usb.AdbDaemonWebUsbDeviceManager.BROWSER;
            if (!manager) throw new Error("WebUSB is not available in this browser.");

            setStatus("Choose your phone in the browser prompt...");
            device = await manager.requestDevice();
            if (!device) {
                setStatus("No device selected.");
                return;
            }

            var connection;
            try {
                setStatus("Opening the USB connection...");
                connection = await device.connect();
            } catch (error) {
                var busy = lib.usb.AdbDaemonWebUsbDevice && lib.usb.AdbDaemonWebUsbDevice.DeviceBusyError;
                if ((busy && error instanceof busy) || /busy|claim|in use|access denied/i.test(String(error && error.message))) {
                    var detail = (error && error.name ? error.name + ": " : "") + String(error && error.message ? error.message : error);
                    var windows = /win/i.test(navigator.platform || "");
                    throw new Error(
                        "The device is in use by another program (such as Android Studio), or Windows is using its own driver for it. To use it together with Android Studio, switch to \"ADB server\" mode above. " +
                        (windows
                            ? "Run \"adb kill-server\" and \"taskkill /F /IM adb.exe\", close Android Studio, scrcpy and other phone tools, unplug and replug the cable, then try again. If it still fails, the Google USB driver may need to be replaced with WinUSB (Zadig). "
                            : "Run \"adb kill-server\", close Android Studio and other phone tools, unplug and replug the cable, then try again. ") +
                        "[" + detail + "]"
                    );
                }
                throw error;
            }

            setStatus("Waiting for you to accept \"Allow USB debugging\" on the phone...");
            var transport = await lib.adb.AdbDaemonTransport.authenticate({
                serial: device.serial,
                connection: connection,
                credentialStore: new lib.credential.default("SQLite Viewer")
            });

            adb = new lib.adb.Adb(transport);
            if (adb.disconnected && adb.disconnected.then) {
                adb.disconnected.then(handleDisconnected, handleDisconnected);
            }

            setConnectedUi(true);
            await loadApps();
        } catch (error) {
            console.error(error);
            adb = null;
            setConnectedUi(false);
            setStatus(String(error && error.message ? error.message : error), "error");
        } finally {
            $("android_connect").disabled = false;
        }
    }

    /* ---- ADB server mode (through the local bridge) ------------------------ */

    var PRODUCTION_ORIGIN = "https://sqliteviewer.codemasterlk.com";
    var DEFAULT_BRIDGE_URL = "ws://127.0.0.1:5038";
    var serverClient = null;
    var serverDevices = [];

    function bridgeCommand() {
        var command = "python adb-bridge.py";
        // Pages opened from disk (file://) send the origin "null".
        var origin = location.protocol === "file:" ? "null" : location.origin;
        if (origin !== PRODUCTION_ORIGIN) command += " --allow-origin " + origin;
        return command;
    }

    // Connector for AdbServerClient: every connection is a WebSocket to the bridge,
    // which relays it to the ADB server's TCP port.
    function createWebSocketConnector(url) {
        function connect(options) {
            return new Promise(function (resolve, reject) {
                var socket;
                try {
                    socket = new WebSocket(url);
                } catch (error) {
                    reject(error);
                    return;
                }

                socket.binaryType = "arraybuffer";
                var opened = false;
                var markClosed;
                var closed = new Promise(function (resolveClosed) { markClosed = resolveClosed; });

                var readable = new ReadableStream({
                    start: function (controller) {
                        socket.onmessage = function (event) {
                            controller.enqueue(new Uint8Array(event.data));
                        };
                        socket.onclose = function () {
                            try { controller.close(); } catch (ignored) { }
                            markClosed();
                            if (!opened) reject(new Error("The bridge closed the connection."));
                        };
                        socket.onerror = function () {
                            if (!opened) {
                                reject(new Error("Could not reach the bridge."));
                            } else {
                                try { controller.error(new Error("The bridge connection failed.")); } catch (ignored) { }
                            }
                        };
                    },
                    cancel: function () { socket.close(); }
                });

                var writable = new WritableStream({
                    write: function (chunk) {
                        var wrapped = chunk && typeof chunk === "object" && !(chunk instanceof Uint8Array) && "value" in chunk;
                        socket.send(wrapped ? chunk.value : chunk);
                        if (wrapped && typeof chunk.consume === "function") chunk.consume();
                    },
                    close: function () { socket.close(); },
                    abort: function () { socket.close(); }
                });

                socket.onopen = function () {
                    opened = true;
                    resolve({
                        readable: readable,
                        writable: writable,
                        closed: closed,
                        close: function () { socket.close(); }
                    });
                };

                if (options && options.signal) {
                    options.signal.addEventListener("abort", function () { socket.close(); });
                }
            });
        }

        return {
            connect: connect,
            addReverseTunnel: function () { return Promise.reject(new Error("Reverse tunnels are not supported through the bridge.")); },
            removeReverseTunnel: function () { return Promise.resolve(); },
            clearReverseTunnels: function () { return Promise.resolve(); }
        };
    }

    function currentMode() {
        var checked = document.querySelector('input[name="android_mode"]:checked');
        return checked ? checked.value : "usb";
    }

    function updateModeUi() {
        var server = currentMode() === "server";
        $("android_server_box").style.display = server ? "" : "none";
        $("android_bridge_cmd").textContent = bridgeCommand();
        $("android_file_note").style.display = location.protocol === "file:" ? "" : "none";
        $("android_connect").textContent = server ? "Connect through bridge" : "Connect device";

        try {
            localStorage.setItem("sqliteViewer.androidMode", server ? "server" : "usb");
        } catch (ignored) { }
    }

    async function attachServerDevice(entry) {
        setStatus("Attaching to " + (entry.model || entry.serial) + "...");
        adb = await serverClient.createAdb({ transportId: entry.transportId });
        device = { serial: entry.serial };

        if (adb.disconnected && adb.disconnected.then) {
            adb.disconnected.then(handleDisconnected, handleDisconnected);
        }

        $("android_device_row").style.display = "none";
        $("android_use_device").style.display = "none";
        setConnectedUi(true);
        await loadApps();
    }

    async function connectViaServer() {
        var lib = await loadLibraries();
        var url = $("android_ws_url").value.trim() || DEFAULT_BRIDGE_URL;

        setStatus("Connecting to the bridge...");
        serverClient = new lib.adb.AdbServerClient(createWebSocketConnector(url));

        try {
            await serverClient.getVersion();
        } catch (error) {
            console.error(error);
            serverClient = null;
            throw new Error("Could not reach the ADB bridge at " + url + ". Download and start it first (see below): " +
                bridgeCommand() + ". The bridge window lists any blocked origin.");
        }

        var all = await serverClient.getDevices(["device", "unauthorized", "offline"]);
        serverDevices = all.filter(function (entry) { return entry.state === "device"; });

        if (serverDevices.length === 0) {
            serverClient = null;
            var waiting = all.some(function (entry) { return entry.state === "unauthorized"; });
            throw new Error(waiting
                ? "The phone is waiting for you to accept \"Allow USB debugging\" on its screen."
                : "The ADB server sees no phone. Check the cable, enable USB debugging and run \"adb devices\".");
        }

        if (serverDevices.length === 1) {
            await attachServerDevice(serverDevices[0]);
            return;
        }

        var select = $("android_device");
        select.innerHTML = "";
        serverDevices.forEach(function (entry, index) {
            var option = document.createElement("option");
            option.value = String(index);
            option.textContent = (entry.model || entry.product || "Device") + " (" + entry.serial + ")";
            select.appendChild(option);
        });
        $("android_device_row").style.display = "";
        $("android_use_device").style.display = "";
        setStatus("Several phones are connected. Choose one.");
    }

    async function useSelectedDevice() {
        var entry = serverDevices[parseInt($("android_device").value, 10)];
        if (!entry) return;

        try {
            await attachServerDevice(entry);
        } catch (error) {
            console.error(error);
            setStatus(String(error && error.message ? error.message : error), "error");
        }
    }

    async function connect() {
        if (currentMode() !== "server") {
            await connectUsb();
            return;
        }

        $("android_connect").disabled = true;

        try {
            await connectViaServer();
        } catch (error) {
            console.error(error);
            adb = null;
            setConnectedUi(false);
            setStatus(String(error && error.message ? error.message : error), "error");
        } finally {
            $("android_connect").disabled = false;
        }
    }

    function handleDisconnected() {
        if (!adb) return;
        adb = null;
        device = null;
        setLiveControls(false);
        setConnectedUi(false);
        setStatus("The device was disconnected. The last copy of the database stays open.", "error");
    }

    async function disconnect() {
        var closing = adb;
        serverClient = null;
        adb = null;
        device = null;
        setLiveControls(false);
        setConnectedUi(false);
        setStatus("Disconnected.");

        try {
            if (closing && closing.close) await closing.close();
        } catch (error) {
            console.warn(error);
        }
    }

    /* ---- Opening and refreshing ------------------------------------------------- */

    async function pullAndShow(manual, force) {
        if (!adb || !current) return;

        if (pulling) {
            if (manual === false) scheduleAutoRefresh();
            return;
        }

        pulling = true;
        if (manual === true) setSpinning(true);
        stats.checks++;
        stats.lastCheck = timeText();

        function say(text, kind) {
            setStatus(text, kind);
            if (manual === true) notify(text);
        }

        try {
            var pulled = await withTimeout(
                pullDatabase(current.packageName, current.databaseName),
                PULL_TIMEOUT_MS,
                "The phone did not respond in time. Check the cable and that the screen is unlocked."
            );

            // A manual refresh always reloads from the phone, even when there are unsent local edits.
            var hasLocalEdits = manual === true && current.sessionId === activeDatabaseSessionId && databaseDirty;

            if (!force && !hasLocalEdits && sameBytes(pulled.bytes, lastBytes)) {
                say("Up to date · checked " + timeText(), "ok");
                setChip("LIVE · checked " + timeText(), "ok");
                return;
            }

            var outcome = refreshActiveDatabaseBytes(current.sessionId, pulled.bytes, manual === true);

            if (outcome.status === "ok") {
                lastBytes = pulled.bytes;
                stats.updates++;
                say(outcome.discardedEdits
                    ? "Reloaded from the phone " + timeText() + ". Unsent local edits were discarded."
                    : "Updated " + timeText() + (pulled.walFrames ? " (including " + pulled.walFrames + " recent write-log pages)" : ""), "ok");
                setChip("LIVE · updated " + timeText(), "ok", true);
            } else if (outcome.status === "inactive") {
                say("Paused: switch back to the device database tab to see updates.");
                setChip("LIVE paused · open the device tab", "warn");
            } else if (outcome.status === "dirty") {
                if (live.pending === 0) {
                    say("Refresh skipped: this tab has local edits that would be lost.", "error");
                    setChip("LIVE paused · local edits", "warn");
                }
            } else if (outcome.status === "busy") {
                say("The viewer is busy. Trying again shortly.");
            } else {
                say("Could not read the new copy: " + (outcome.message || "unknown error"), "error");
                setChip("LIVE · read error", "error");
            }
        } catch (error) {
            console.error(error);
            stats.errors++;
            say(String(error && error.message ? error.message : error), "error");
            setChip("LIVE · " + (error && error.message ? error.message : "error"), "error");
        } finally {
            pulling = false;
            if (manual === true) setSpinning(false);
            updateDiag();
            if (manual === false) scheduleAutoRefresh();
        }
    }

    async function openSelected() {
        var packageName = $("android_package").value;
        var databaseName = $("android_database").value;
        if (!adb || !packageName || !databaseName || pulling) return;

        pulling = true;
        $("android_load").disabled = true;

        try {
            setStatus("Copying " + databaseName + " from the phone...");
            var pulled = await pullDatabase(packageName, databaseName);
            var key = (device ? device.serial : "device") + "|" + packageName + "|" + databaseName;
            var shown = await openAdbDatabase(pulled.bytes, databaseName, {
                type: "adb",
                key: key,
                packageName: packageName,
                databaseName: databaseName
            });

            if (!shown.sessionId) throw new Error(shown.message || "The database could not be opened.");

            current = { sessionId: shown.sessionId, packageName: packageName, databaseName: databaseName };
            lastBytes = pulled.bytes;
            setLiveControls(true);
            await applyOptionsAfterOpen();
            setStatus("Opened " + databaseName + " · " + timeText() +
                (pulled.walFrames ? " (including " + pulled.walFrames + " recent write-log pages)" : ""), "ok");

            // Get the dialog out of the way so the database is visible.
            close();
            if (typeof showToast === "function") {
                showToast("Opened " + databaseName, Math.max(12, window.innerWidth / 2 - 70), 72);
            }
        } catch (error) {
            console.error(error);
            setStatus(String(error && error.message ? error.message : error), "error");
        } finally {
            pulling = false;
            $("android_load").disabled = false;
        }
    }

    var toastRect = null;

    function notify(text) {
        if (toastRect && typeof showToast === "function") showToast(text, toastRect.left, toastRect.bottom);
    }

    var manualRefreshing = false;

    function setSpinning(on) {
        manualRefreshing = on;
        Array.prototype.forEach.call(document.querySelectorAll(".database-tab-refresh"), function (icon) {
            icon.classList.toggle("is-spinning", on);
        });
    }

    // Manual refresh from the icon inside a database tab.
    function refreshNow(sessionId, rect) {
        toastRect = rect || null;

        if (!adb || !current || current.sessionId !== sessionId) {
            notify("Not connected to the phone. Open the Android panel to reconnect.");
            open();
            setStatus("This database was opened from a phone that is no longer connected. Connect again and open it to refresh.", "error");
            return;
        }

        if (databaseSessions.every(function (session) { return session.id !== sessionId; })) return;
        if (sessionId !== activeDatabaseSessionId) switchDatabaseSession(sessionId);

        pullAndShow(true);
    }

    var stats = { checks: 0, updates: 0, errors: 0, lastCheck: "", lastResult: "", restarts: 0 };
    var watchdog = null;

    function updateDiag() {
        var line = $("android_diag");
        if (!line) return;

        if (!$("android_auto").checked) {
            if ($("android_auto").disabled) {
                line.style.display = "";
                line.textContent = "Select an app and a database to turn on auto-refresh.";
            } else {
                line.style.display = "none";
            }
            return;
        }

        if (!current) {
            line.style.display = "";
            line.textContent = "Auto-refresh will start when you click 'Open database'.";
            return;
        }

        var seconds = Math.round((parseInt($("android_interval").value, 10) || 5000) / 1000);
        line.style.display = "";
        line.textContent = "Auto-refresh is on (every " + seconds + " s) · checks: " + stats.checks +
            " · updates: " + stats.updates + " · errors: " + stats.errors +
            (stats.lastCheck ? " · last check " + stats.lastCheck : "") +
            (stats.restarts ? " · restarted " + stats.restarts + "x" : "");
    }

    // If the polling chain ever dies for any reason, start it again.
    function startWatchdog() {
        if (watchdog) return;

        watchdog = setInterval(function () {
            if ($("android_auto").checked && adb && current && !autoTimer && !pulling) {
                stats.restarts++;
                console.warn("[live] auto-refresh was idle; restarting it");
                scheduleAutoRefresh();
                updateDiag();
            }
        }, 2000);
    }

    function stopAutoRefresh() {
        clearTimeout(autoTimer);
        autoTimer = null;
    }

    function scheduleAutoRefresh() {
        stopAutoRefresh();
        if (!$("android_auto").checked || !adb || !current) return;

        // Keep polling when the tab is in the background (browsers throttle timers
        // there anyway), just less often, so the data is current when you come back.
        var delay = parseInt($("android_interval").value, 10) || 5000;
        if (document.hidden) delay = Math.max(delay, BACKGROUND_MIN_INTERVAL_MS);

        autoTimer = setTimeout(function () {
            if (!databaseSessions.some(function (session) { return session.id === current.sessionId; })) {
                $("android_auto").checked = false;
                setChip("", "");
                setStatus("Auto-refresh stopped: the database tab was closed.");
                return;
            }

            autoTimer = null;
            console.debug("[live] auto-refresh check");
            pullAndShow(false).catch(function (error) {
                console.error(error);
                scheduleAutoRefresh();
            });
        }, delay);
    }

    /* ---- Push to phone ------------------------------------------------------------- */

    var PUSH_CHUNK = 32 * 1024;
    var pushing = false;
    var pushPlan = null; // { sessionId, packageName, databaseName, bytes, phoneBytes, phoneChanged }

    function pushSource() {
        var session = getActiveDatabaseSession();
        if (!session || !session.source || session.source.type !== "adb") return null;
        return { session: session, packageName: session.source.packageName, databaseName: session.source.databaseName };
    }

    function formatSize(count) {
        return typeof formatBytes === "function" ? formatBytes(count) : count + " B";
    }

    function setPushStatus(text, kind) {
        var el = $("android_push_status");
        el.textContent = text || "";
        el.className = "android-status" + (kind ? " is-" + kind : "");
    }

    function setStep(name, state) {
        var item = document.querySelector('#android_push_steps [data-step="' + name + '"]');
        if (item) item.className = state ? "is-" + state : "";
    }

    function resetSteps() {
        Array.prototype.forEach.call(document.querySelectorAll("#android_push_steps li"), function (item) {
            item.className = "";
        });
    }

    function concatChunks(chunks) {
        var total = 0;
        chunks.forEach(function (chunk) { total += chunk.length; });
        var out = new Uint8Array(total);
        var offset = 0;
        chunks.forEach(function (chunk) { out.set(chunk, offset); offset += chunk.length; });
        return out;
    }

    async function drain(stream) {
        var reader = stream.getReader();
        var chunks = [];

        for (;;) {
            var step = await reader.read();
            if (step.done) break;
            chunks.push(step.value);
        }

        return concatChunks(chunks);
    }

    // Runs a command on the phone and feeds `bytes` to its standard input.
    async function runWithInput(command, bytes) {
        var shell = adb.subprocess.shellProtocol;
        if (!shell) {
            throw new Error("This phone does not support the shell protocol needed to write files (Android 7 or newer).");
        }

        var process = await shell.spawn(command);
        var outPromise = drain(process.stdout);
        var errPromise = drain(process.stderr);
        var writer = process.stdin.getWriter();

        for (var offset = 0; offset < bytes.length; offset += PUSH_CHUNK) {
            await writer.write(bytes.subarray(offset, offset + PUSH_CHUNK));
        }

        await writer.close();
        var code = await process.exited;

        return {
            code: code,
            stdout: decoder.decode(await outPromise),
            stderr: decoder.decode(await errPromise)
        };
    }

    async function sha1Hex(bytes) {
        var digest = await crypto.subtle.digest("SHA-1", bytes);
        return Array.prototype.map.call(new Uint8Array(digest), function (value) {
            return ("0" + value.toString(16)).slice(-2);
        }).join("");
    }

    // Writes `bytes` next to the real database, checks them, then swaps them in.
    // The original is only touched in the final "replace" step.
    async function pushDatabaseBytes(packageName, databaseName, bytes, options, onStep) {
        assertSafe(packageName, "Package name");
        assertSafe(databaseName, "Database name");
        options = options || {};
        onStep = onStep || function () { };

        var path = "databases/" + databaseName;
        var temp = path + ".vstmp";

        async function discardTemp() {
            try { await runShell("run-as " + packageName + " rm -f " + temp); } catch (ignored) { }
        }

        if (options.stopApp) {
            onStep("stop", "run");
            await runShell("am force-stop " + packageName);
            await new Promise(function (resolve) { setTimeout(resolve, 600); });
            onStep("stop", "done");
        } else {
            onStep("stop", "skip");
        }

        onStep("upload", "run");
        var written = await runWithInput("run-as " + packageName + " sh -c 'cat > " + temp + "'", bytes);
        if (written.code !== 0) {
            await discardTemp();
            throw new Error("Could not write to the app folder: " + (written.stderr.trim() || "exit code " + written.code));
        }
        onStep("upload", "done");

        onStep("verify", "run");
        var expected = await sha1Hex(bytes);
        var check = await runShellText("run-as " + packageName + " sh -c 'wc -c < " + temp + "; sha1sum " + temp + "'");
        var lines = check.text.split(/\r?\n/).map(function (line) { return line.trim(); }).filter(Boolean);
        var size = parseInt(lines[0], 10);
        var hash = lines[1] ? lines[1].split(/\s+/)[0].toLowerCase() : "";

        if (size !== bytes.length) {
            await discardTemp();
            throw new Error("The copy on the phone has the wrong size (" + size + " instead of " + bytes.length + " bytes).");
        }

        if (/^[0-9a-f]{40}$/.test(hash) && hash !== expected) {
            await discardTemp();
            throw new Error("The copy on the phone does not match what was sent (checksum differs).");
        }
        onStep("verify", "done");

        // A leftover write-ahead log or journal from the old file would corrupt the new one.
        onStep("replace", "run");
        var swapped = await runShell("run-as " + packageName + " sh -c 'rm -f " + path + "-wal " + path + "-shm " + path +
            "-journal && mv " + temp + " " + path + "'");
        if (swapped.code !== 0) {
            await discardTemp();
            throw new Error("Could not replace the database: " + (decoder.decode(swapped.stdout) + swapped.stderr).trim());
        }
        onStep("replace", "done");

        if (options.startApp) {
            onStep("start", "run");
            try {
                await runShell("monkey -p " + packageName + " -c android.intent.category.LAUNCHER 1");
                onStep("start", "done");
            } catch (ignored) {
                onStep("start", "skip");
            }
        } else {
            onStep("start", "skip");
        }
    }

    function exportEditedBytes() {
        var checked = db.exec("PRAGMA quick_check");
        var verdict = checked[0] && checked[0].values[0] ? checked[0].values[0][0] : "ok";
        if (verdict !== "ok") throw new Error("The edited database failed an integrity check: " + verdict);

        var bytes = db.export();
        if (!isSqlite(bytes)) throw new Error("The edited database is not a valid SQLite file.");
        return bytes;
    }

    async function openPush() {
        bind();
        var source = pushSource();

        if (!source || !adb || !current || current.sessionId !== source.session.id) {
            open();
            setStatus(source
                ? "Connect to the phone and open this database again to push changes."
                : "Open a database from the phone first.", "error");
            return;
        }

        pushPlan = null;
        resetSteps();
        $("android_push_confirm").checked = false;
        $("android_push_go").disabled = true;
        $("android_push_go").textContent = "Push to phone";
        $("android_push_cancel").textContent = "Cancel";
        $("android_push_summary").textContent = source.packageName + " · " + source.databaseName;
        $("android_push_warning").className = "android-warning";
        $("android_push_panel").style.display = "flex";
        setPushStatus("Checking the phone...");

        try {
            var bytes = exportEditedBytes();
            var phone = await withTimeout(
                pullDatabase(source.packageName, source.databaseName),
                PULL_TIMEOUT_MS,
                "The phone did not respond in time. Check the cable and that the screen is unlocked."
            );
            var changed = !sameBytes(phone.bytes, lastBytes);

            pushPlan = {
                sessionId: source.session.id,
                packageName: source.packageName,
                databaseName: source.databaseName,
                bytes: bytes,
                phoneBytes: phone.bytes,
                phoneChanged: changed
            };

            $("android_push_summary").textContent = source.packageName + " · " + source.databaseName +
                " · phone " + formatSize(phone.bytes.length) + " → new " + formatSize(bytes.length);

            if (changed) {
                $("android_push_warning").className = "android-warning is-strong";
                $("android_push_warning").textContent =
                    "The database on the phone changed since you last refreshed. Pushing replaces it and discards those newer " +
                    "changes. They are kept in the backup that is downloaded first.";
                setPushStatus("The phone has newer data than your copy.", "error");
            } else {
                setPushStatus("The phone's database is unchanged since your last refresh. Ready to push.", "ok");
            }

            $("android_push_go").disabled = !$("android_push_confirm").checked;
        } catch (error) {
            console.error(error);
            setPushStatus(String(error && error.message ? error.message : error), "error");
        }
    }

    function backupFileName(databaseName) {
        var now = new Date();
        var pad = function (value) { return ("0" + value).slice(-2); };
        return databaseName + ".phone-backup-" + now.getFullYear() + pad(now.getMonth() + 1) + pad(now.getDate()) + "-" +
            pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + ".sqlite";
    }

    async function doPush() {
        if (!pushPlan || pushing || !adb) return;

        pushing = true;
        pulling = true; // pause automatic refreshes while the file is being replaced
        $("android_push_go").disabled = true;
        $("android_push_cancel").disabled = true;
        $("android_push_close").disabled = true;
        resetSteps();
        var replaced = false;

        try {
            setPushStatus("Pushing...");

            setStep("backup", "run");
            download(backupFileName(pushPlan.databaseName), pushPlan.phoneBytes, "application/vnd.sqlite3");
            setStep("backup", "done");

            await pushDatabaseBytes(pushPlan.packageName, pushPlan.databaseName, pushPlan.bytes, {
                stopApp: $("android_push_stop").checked,
                startApp: $("android_push_start").checked
            }, function (name, state) {
                if (name === "replace" && state === "done") replaced = true;
                setStep(name, state);
            });

            markActiveDatabaseClean(pushPlan.bytes.length);
            lastBytes = pushPlan.bytes;
            setPushStatus("Done. The phone now has your edited database at " + timeText() + ".", "ok");
            setChip("LIVE · pushed " + timeText(), "ok", true);
            $("android_push_go").style.display = "none";
            $("android_push_cancel").textContent = "Close";
            pushPlan = null;
        } catch (error) {
            console.error(error);
            Array.prototype.forEach.call(document.querySelectorAll("#android_push_steps li.is-run"), function (item) {
                item.className = "is-fail";
            });
            setPushStatus("Push failed: " + String(error && error.message ? error.message : error) +
                (replaced ? "" : " The database on the phone was not changed."), "error");
            $("android_push_go").disabled = !$("android_push_confirm").checked;
        } finally {
            pushing = false;
            pulling = false;
            $("android_push_cancel").disabled = false;
            $("android_push_close").disabled = false;
        }
    }

    function closePush() {
        if (pushing) return;
        $("android_push_panel").style.display = "none";
        $("android_push_go").style.display = "";
    }

    /* ---- Live edit through the debug helper ---------------------------------------- */

    var LIVE_MAX_ARG = 100000;
    var LIVE_GUIDE_URL = "guides/android-live-edit/";
    var live = { enabled: false, helperFound: false, pending: 0, queue: Promise.resolve() };

    function base64Utf8(text) {
        var bytes = new TextEncoder().encode(text);
        var binary = "";
        for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }

    // Calls the helper ContentProvider that is compiled into the debug app.
    async function contentCall(packageName, method, databaseName, argument) {
        assertSafe(packageName, "Package name");
        var command = "content call --uri content://" + packageName + ".sqliteviewer --method " + method;

        if (databaseName) {
            assertSafe(databaseName, "Database name");
            command += " --extra db:s:" + databaseName;
        }

        if (argument) command += " --arg " + argument;

        var result = await runShellText(command);
        var match = /Result: Bundle\[\{r=([\s\S]*)\}\]/.exec(result.text);

        if (!match) {
            var failure = new Error(
                /Could not find provider|Unknown URL|Error while accessing provider/i.test(result.text + result.stderr)
                    ? "The live-edit helper was not found in this app. Add it to your debug build (see the setup guide)."
                    : (result.text + result.stderr).trim() || "The helper did not answer."
            );
            failure.noHelper = /not found in this app/.test(failure.message);
            throw failure;
        }

        if (/^ERR:/.test(match[1])) throw new Error(match[1].slice(4));
        return match[1];
    }

    function setHelperStatus(html, kind) {
        var line = $("android_helper_status");
        if (!line) return;
        line.innerHTML = html;
        line.className = "android-diag" + (kind ? " is-" + kind : "");
    }

    function setLiveChip(visible, text, kind) {
        buttonState.edit = visible ? { text: text, kind: kind || "ok" } : null;
        renderLiveButton();
    }

    var helperCache = {}; // package name -> true | false | { error: "..." } | undefined (unknown)
    var preferenceApplied = {};

    function selectionReady() {
        return !!(adb && $("android_package").value && $("android_database").value);
    }

    // Auto-refresh and Live edit are available as soon as an app and a database are selected,
    // so they can be chosen before "Open database" (the dialog closes when the database opens).
    function refreshOptions() {
        var ready = selectionReady();
        var pkg = $("android_package").value;
        var helper = helperCache[pkg];

        $("android_auto").disabled = !ready;
        $("android_refresh").disabled = !(adb && current);
        $("android_live_edit").disabled = !(ready && helper === true);
        updateDiag();

        if (!ready) {
            setHelperStatus("Select an app and a database to use live edit.");
        } else if (helper === undefined) {
            setHelperStatus("Checking for the live-edit helper in " + pkg + "...");
        } else if (helper === true) {
            setHelperStatus("Live-edit helper found in this app.", "ok");
        } else if (helper === false) {
            setHelperStatus("Live edit needs a small helper in your debug app. " +
                '<a href="' + LIVE_GUIDE_URL + '" target="_blank" rel="noopener">Setup guide</a>', "error");
        } else {
            setHelperStatus("Could not check the helper: " + helper.error, "error");
        }
    }

    async function checkHelperFor(packageName) {
        if (!adb || !packageName) return false;

        helperCache[packageName] = undefined;
        refreshOptions();

        try {
            await contentCall(packageName, "ping");
            helperCache[packageName] = true;
        } catch (error) {
            helperCache[packageName] = error && error.noHelper
                ? false
                : { error: String(error && error.message ? error.message : error) };
        }

        // Remember the choice from last time, once per app.
        if (helperCache[packageName] === true && !preferenceApplied[packageName]) {
            preferenceApplied[packageName] = true;
            try {
                if (localStorage.getItem("sqliteViewer.liveEdit") === "1") $("android_live_edit").checked = true;
            } catch (ignored) { }
        }

        refreshOptions();
        return helperCache[packageName] === true;
    }

    function setLiveEdit(on) {
        live.enabled = !!on && !!current && helperCache[current.packageName] === true;
        $("android_live_edit").checked = live.enabled;
        setLiveChip(live.enabled, "LIVE EDIT", "ok");
    }

    // Applies the options that were ticked before the database was opened.
    async function applyOptionsAfterOpen() {
        var packageName = current.packageName;
        await checkHelperFor(packageName);

        setLiveEdit($("android_live_edit").checked && helperCache[packageName] === true);

        if ($("android_auto").checked) {
            setChip("LIVE · auto-refresh on", "ok");
            scheduleAutoRefresh();
        }

        refreshOptions();
    }

    // Used by main.js: true when edits in the active tab should go to the phone.
    function liveEditActive() {
        return live.enabled && !!adb && !!current && current.sessionId === activeDatabaseSessionId;
    }

    function liveForward(statements, label) {
        var target = current;
        live.pending++;
        setLiveChip(true, "LIVE EDIT · sending...", "warn");

        live.queue = live.queue.then(async function () {
            var argument = base64Utf8(JSON.stringify(statements));
            if (argument.length > LIVE_MAX_ARG) {
                throw new Error("This edit is too large to send live (about 75 KB at most). Use Push to phone instead.");
            }

            await contentCall(target.packageName, "batch", target.databaseName, argument);
        }).then(function () {
            live.pending--;
            if (live.pending > 0) return;

            if (current && current.sessionId === target.sessionId && activeDatabaseSessionId === target.sessionId) {
                markActiveDatabaseClean();
            }

            setLiveChip(live.enabled, "LIVE EDIT · sent " + timeText(), "ok");
            if (typeof setQueryResultStatus === "function") {
                setQueryResultStatus(label + " sent to the phone at " + timeText() + ".", "success");
            }
        }, function (error) {
            live.pending--;
            console.error(error);
            var message = String(error && error.message ? error.message : error);
            // Make the viewer match the phone again, then show why, so the message is not overwritten.
            markActiveDatabaseClean();

            setTimeout(function () {
                pullAndShow(true, true).then(function () {
                    setLiveChip(live.enabled, "LIVE EDIT · rejected", "error");
                    setStatus("The app rejected the edit: " + message, "error");

                    if (typeof setQueryResultStatus === "function") {
                        setQueryResultStatus("The phone did not accept the " + label.toLowerCase() + ": " +
                            message.replace(/[.\s]+$/, "") + ". Your change was undone.", "warning");
                    }
                });
            }, 400);
        });
    }

    /* ---- Dialog wiring ------------------------------------------------------------- */

    function bind() {
        if (bound) return;
        bound = true;

        $("android_close").addEventListener("click", close);
        $("android_push_close").addEventListener("click", closePush);
        $("android_live_edit").addEventListener("change", function () {
            var on = $("android_live_edit").checked;
            try { localStorage.setItem("sqliteViewer.liveEdit", on ? "1" : "0"); } catch (ignored) { }

            var appliesNow = !!current && $("android_package").value === current.packageName;

            if (!appliesNow) {
                setStatus(on ? "Live edit will turn on when you click 'Open database'." : "Live edit is off.");
                return;
            }

            if (on && helperCache[current.packageName] !== true) {
                $("android_live_edit").checked = false;
                return;
            }

            setLiveEdit(on);
            setStatus(live.enabled
                ? "Live edit is on: your edits are sent to the phone as you make them."
                : "Live edit is off.", live.enabled ? "ok" : "");
        });
        $("android_database").addEventListener("change", refreshOptions);
        $("android_push_cancel").addEventListener("click", closePush);
        $("android_push_go").addEventListener("click", doPush);
        $("android_push_confirm").addEventListener("change", function () {
            $("android_push_go").disabled = !pushPlan || pushing || !$("android_push_confirm").checked;
        });
        $("android_connect").addEventListener("click", connect);
        $("android_use_device").addEventListener("click", useSelectedDevice);
        Array.prototype.forEach.call(document.querySelectorAll('input[name="android_mode"]'), function (radio) {
            radio.addEventListener("change", function () {
                updateModeUi();
                setStatus(currentMode() === "server"
                    ? "Start the bridge on your computer, then connect."
                    : "Plug in your phone with USB debugging enabled, then connect.");
            });
        });
        $("android_disconnect").addEventListener("click", disconnect);
        $("android_load").addEventListener("click", openSelected);
        $("android_refresh").addEventListener("click", function () { pullAndShow(true); });
        $("android_package").addEventListener("change", function () {
            loadDatabases().catch(function (error) {
                setStatus(String(error && error.message ? error.message : error), "error");
            });
        });
        startWatchdog();
        $("android_auto").addEventListener("change", function () {
            updateDiag();

            if ($("android_auto").checked) {
                if (current) {
                    pullAndShow(false);
                } else {
                    setStatus("Auto-refresh will start when you click 'Open database'.");
                }
            } else {
                stopAutoRefresh();
                setChip("", "");
                setStatus("Auto-refresh off.");
            }
        });
        $("android_interval").addEventListener("change", scheduleAutoRefresh);
        $("android_panel").addEventListener("click", function (event) {
            if (event.target === $("android_panel")) close();
        });
        document.addEventListener("keydown", function (event) {
            if (event.key === "Escape" && $("android_panel").style.display !== "none") close();
        });
    }

    function open() {
        bind();
        $("android_panel").style.display = "flex";
        refreshOptions();

        if (!modeRestored) {
            modeRestored = true;
            var saved = "usb";
            try { saved = localStorage.getItem("sqliteViewer.androidMode") || "usb"; } catch (ignored) { }

            // Browsers without WebUSB can still use the ADB server through the bridge.
            if (!navigator.usb) saved = "server";
            document.querySelector('input[name="android_mode"][value="' + saved + '"]').checked = true;
            document.querySelector('input[name="android_mode"][value="usb"]').disabled = !navigator.usb;
            updateModeUi();
        }

        if (!adb && !$("android_status").textContent) {
            setStatus(currentMode() === "server"
                ? "Start the bridge on your computer, then connect."
                : "Plug in your phone with USB debugging enabled, then connect.");
        }
    }

    function close() {
        $("android_panel").style.display = "none";
    }

    window.AndroidAdb = {
        open: open,
        refreshNow: refreshNow,
        openPush: openPush,
        refreshButton: function () { renderLiveButton(); },
        liveEditActive: liveEditActive,
        liveForward: liveForward,
        _contentCall: contentCall,
        _pushDatabaseBytes: pushDatabaseBytes,
        isManualRefreshing: function () { return manualRefreshing; },
        close: close,
        // Exposed for tests.
        _applyWal: applyWal,
        _splitPullOutput: splitPullOutput,
        _isSqlite: isSqlite,
        _pullDatabase: pullDatabase,
        _setAdb: function (fake, fakeDevice) { adb = fake; device = fakeDevice || null; },
        _afterConnect: async function () { setConnectedUi(true); await loadApps(); }
    };
}());
