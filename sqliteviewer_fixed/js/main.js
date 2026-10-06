var SQL_LIMIT_REGEX = /LIMIT\s+(\d+)(?:\s*,\s*(\d+))?/mi;
var SQL_SELECT_REGEX = /SELECT\s+[^;]+\s+FROM\s+/mi;

var db = null;
var rowCounts = [];
var editor = ace.edit("sql-editor");
var export_query_builder_editor = ace.edit("customer_query_build_edit_text");
var bottomBarDefaultPos = null, bottomBarDisplayStyle = null;
var errorBox = $("#error");
var lastCachedQueryCount = {};
var orderByName = "DESC";
var schemaSuggestions = [];
var schemaLoaded = false;
var tableMetaList = [];
var currentTableSort = "name";
var visibleColumns = {};
var currentColumnNames = [];
var pinnedColumns = {};
var erCy = null;
var loadedDatabaseName = "database.sqlite";
var loadedDatabaseBytes = 0;
var databaseDirty = false;
var currentResultRows = [];
var currentEditableContext = null;
var rowEditorState = null;
var MAX_RENDERED_ROWS = 1000;
var QUERY_HISTORY_LIMIT = 50;
var queryTabs = [];
var activeQueryTabId = null;
var queryHistory = [];
var queryWorkspaceChanging = false;
var queryWorkspaceSaveTimer = null;
var suppressTableSelectionChange = false;
var databaseSessions = [];
var activeDatabaseSessionId = null;
var sqlJsModule = null;
var databaseLoadQueue = Promise.resolve();
var databaseOperationInProgress = false;
var systemThemeMedia = window.matchMedia("(prefers-color-scheme: dark)");

function resolveAppTheme(preference) {
    return preference === "system"
        ? (systemThemeMedia.matches ? "dark" : "light")
        : preference;
}

function updateThemeSwitch(preference) {
    var options = document.querySelectorAll("[data-theme-option]");
    for (var i = 0; i < options.length; i++) {
        var selected = options[i].getAttribute("data-theme-option") === preference;
        options[i].classList.toggle("is-selected", selected);
        options[i].setAttribute("aria-checked", selected ? "true" : "false");
    }
}

function applyAppTheme(preference, persist) {
    if (["system", "light", "dark"].indexOf(preference) === -1) {
        preference = "system";
    }

    var resolved = resolveAppTheme(preference);
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document.documentElement.style.colorScheme = resolved;
    updateThemeSwitch(preference);
    if (typeof erCy !== "undefined" && erCy && typeof getERDiagramStyle === "function") {
        erCy.style(getERDiagramStyle());
    }

    if (persist) {
        try {
            localStorage.setItem("sqlite-viewer-theme", preference);
        } catch (error) { }
    }
}

function setAppTheme(preference) {
    applyAppTheme(preference, true);
}

function handleSystemThemeChange() {
    if (document.documentElement.dataset.themePreference === "system") {
        applyAppTheme("system", false);
    }
}

if (systemThemeMedia.addEventListener) {
    systemThemeMedia.addEventListener("change", handleSystemThemeChange);
} else if (systemThemeMedia.addListener) {
    systemThemeMedia.addListener(handleSystemThemeChange);
}

applyAppTheme(document.documentElement.dataset.themePreference || "system", false);

var tableSortCache = {
    rows: false,
    cells: false,
    bytes: false
};

$.urlParam = function (name) {
    var results = new RegExp('[\?&]' + name + '=([^&#]*)').exec(window.location.href);
    if (results == null) {
        return null;
    }
    else {
        return results[1] || 0;
    }
};

var fileReaderOpts = {
    readAsDefault: "ArrayBuffer", on: {
        load: function (e, file) {
            return loadDB(e.target.result, file && file.name ? file.name : "database.sqlite");
        }
    }
};

var selectFormatter = function (item) {
    var index = item.text.indexOf("(");
    if (index > -1) {
        var name = item.text.substring(0, index);
        return name + '<span style="color:#ccc">' + item.text.substring(index - 1) + "</span>";
    } else {
        return item.text;
    }
};

var windowResize = function () {
    positionFooter();
    var container = $("#main-container");
    var offset = container.offset();

    if (!container.length || !offset) {
        $("#bottom-bar").css("left", 0);
        return;
    }

    var cleft = offset.left + container.outerWidth();
    $("#bottom-bar").css("left", cleft);
};

var positionFooter = function () {
    var footer = $("#bottom-bar");
    var pager = footer.find("#pager");
    var container = $("#main-container");
    var containerHeight = container.height();
    var footerTop = ($(window).scrollTop() + $(window).height());

    if (bottomBarDefaultPos === null) {
        bottomBarDefaultPos = footer.css("position");
    }

    if (bottomBarDisplayStyle === null) {
        bottomBarDisplayStyle = pager.css("display");
    }

    if (footerTop > containerHeight) {
        footer.css({
            position: "static"
        });
        pager.css("display", "inline-block");
    } else {
        footer.css({
            position: bottomBarDefaultPos
        });
        pager.css("display", bottomBarDisplayStyle);
    }
};

var toggleFullScreen = function () {
    var container = $("#main-container");
    var resizerIcon = $("#resizer i");

    container.toggleClass('container container-fluid');
    resizerIcon.toggleClass('glyphicon-resize-full glyphicon-resize-small');
}
$('#resizer').click(toggleFullScreen);

if (typeof FileReader === "undefined") {
    $('#dropzone, #dropzone-dialog').hide();
    $('#compat-error').show();
} else {
    $('#dropzone, #dropzone-dialog').fileReaderJS(fileReaderOpts);
}

// Wire Excel import file input
document.getElementById("excel-import-dialog").addEventListener("change", function () {
    var file = this.files[0];
    if (file) {
        importExcelFile(file);
        this.value = ""; // reset so same file can be re-imported
    }
});

//Initialize editor
editor.setTheme("ace/theme/chrome");
editor.renderer.setShowGutter(false);
editor.renderer.setShowPrintMargin(false);
editor.renderer.setPadding(20);
editor.renderer.setScrollMargin(8, 8, 0, 0);
editor.setHighlightActiveLine(false);
editor.getSession().setUseWrapMode(true);
editor.getSession().setMode("ace/mode/sql");
editor.setOptions({ maxLines: 15 });
editor.setFontSize(16);
initQueryWorkspace();


function buildSchemaSuggestions() {
    schemaSuggestions = [];

    var keywords = [
        "SELECT", "FROM", "WHERE", "ORDER BY", "GROUP BY", "LIMIT",
        "JOIN", "LEFT JOIN", "INNER JOIN", "INSERT", "UPDATE", "DELETE",
        "COUNT", "SUM", "AVG", "MIN", "MAX", "AND", "OR", "LIKE", "IN"
    ];

    keywords.forEach(function (k) {
        schemaSuggestions.push({ text: k, type: "keyword" });
    });

    if (!db) return;

    var tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='view'");

    while (tables.step()) {
        var tableName = tables.getAsObject().name;

        schemaSuggestions.push({ text: tableName, type: "table" });

        var cols = db.prepare("PRAGMA table_info('" + tableName.replace(/'/g, "''") + "')");

        while (cols.step()) {
            var col = cols.getAsObject();
            schemaSuggestions.push({
                text: col.name,
                type: tableName + " column"
            });
        }
    }

    schemaLoaded = true;
}

var selectedSuggestionIndex = 0;
var autocompleteBox = document.createElement("div");
autocompleteBox.style.position = "absolute";
autocompleteBox.style.zIndex = "999999";
autocompleteBox.style.background = "var(--ui-surface, #fff)";
autocompleteBox.style.color = "var(--ui-text, #172033)";
autocompleteBox.style.border = "1px solid var(--ui-border-strong, #ccc)";
autocompleteBox.style.boxShadow = "0 2px 8px rgba(0,0,0,0.2)";
autocompleteBox.style.display = "none";
autocompleteBox.style.maxHeight = "220px";
autocompleteBox.style.overflowY = "auto";
autocompleteBox.style.fontSize = "14px";
autocompleteBox.style.minWidth = "180px";
document.body.appendChild(autocompleteBox);

function getSqlSuggestions(prefix) {
    prefix = prefix.toLowerCase();

    return schemaSuggestions.filter(function (x) {
        return x.text.toLowerCase().indexOf(prefix) === 0;
    }).slice(0, 30);
}

function getCurrentWord() {
    var pos = editor.getCursorPosition();
    var line = editor.session.getLine(pos.row);
    var left = line.substring(0, pos.column);
    var match = left.match(/[a-zA-Z_][a-zA-Z0-9_]*$/);
    return match ? match[0] : "";
}

function insertSuggestion(value) {
    var word = getCurrentWord();
    var range = editor.selection.getRange();
    range.start.column -= word.length;
    editor.session.replace(range, value);
    autocompleteBox.style.display = "none";
    editor.focus();
}

editor.on("change", function () {
    var word = getCurrentWord();

    if (word.length < 1) {
        autocompleteBox.style.display = "none";
        return;
    }

    var suggestions = getSqlSuggestions(word);

    if (suggestions.length === 0) {
        autocompleteBox.style.display = "none";
        return;
    }

    autocompleteBox.innerHTML = "";

    selectedSuggestionIndex = 0;

    suggestions.forEach(function (item, index) {
        var div = document.createElement("div");
        div.className = "autocomplete-item";
        div.style.padding = "6px 10px";
        div.style.cursor = "pointer";
        div.style.background = index === selectedSuggestionIndex ? "var(--ui-primary-soft, #e8f0fe)" : "var(--ui-surface, #fff)";
        div.innerHTML = "<b>" + item.text + "</b> <span style='color:var(--ui-muted, #999)'>(" + item.type + ")</span>";

        div.onmousedown = function (e) {
            e.preventDefault();
            insertSuggestion(item.text);
        };

        autocompleteBox.appendChild(div);
    });

    var cursor = editor.renderer.$cursorLayer.getPixelPosition(editor.getCursorPosition(), true);
    var editorRect = editor.container.getBoundingClientRect();

    autocompleteBox.style.left = editorRect.left + cursor.left + "px";
    autocompleteBox.style.top = editorRect.top + cursor.top + 25 + "px";
    autocompleteBox.style.display = "block";
});

editor.commands.addCommand({
    name: "autocompleteDown",
    bindKey: { win: "Down", mac: "Down" },
    exec: function (editor) {
        if (autocompleteBox.style.display !== "block") {
            editor.navigateDown(1);
            return;
        }

        var items = autocompleteBox.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;

        selectedSuggestionIndex++;
        if (selectedSuggestionIndex >= items.length) {
            selectedSuggestionIndex = 0;
        }

        refreshSuggestionSelection();
    }
});

editor.commands.addCommand({
    name: "autocompleteUp",
    bindKey: { win: "Up", mac: "Up" },
    exec: function (editor) {
        if (autocompleteBox.style.display !== "block") {
            editor.navigateUp(1);
            return;
        }

        var items = autocompleteBox.querySelectorAll(".autocomplete-item");
        if (items.length === 0) return;

        selectedSuggestionIndex--;
        if (selectedSuggestionIndex < 0) {
            selectedSuggestionIndex = items.length - 1;
        }

        refreshSuggestionSelection();
    }
});

editor.commands.addCommand({
    name: "autocompleteEnter",
    bindKey: { win: "Enter", mac: "Enter" },
    exec: function (editor) {
        if (autocompleteBox.style.display !== "block") {
            editor.insert("\n");
            return;
        }

        var items = autocompleteBox.querySelectorAll(".autocomplete-item");
        if (items.length === 0) {
            autocompleteBox.style.display = "none";
            return;
        }

        var selectedText = items[selectedSuggestionIndex].querySelector("b").innerText;
        insertSuggestion(selectedText);
    }
});

editor.commands.addCommand({
    name: "autocompleteTab",
    bindKey: { win: "Tab", mac: "Tab" },
    exec: function (editor) {
        if (autocompleteBox.style.display !== "block") {
            editor.insert("    ");
            return;
        }

        var items = autocompleteBox.querySelectorAll(".autocomplete-item");
        if (items.length === 0) {
            autocompleteBox.style.display = "none";
            return;
        }

        var selectedText = items[selectedSuggestionIndex].querySelector("b").innerText;
        insertSuggestion(selectedText);
    }
});

editor.commands.addCommand({
    name: "executeQuery",
    bindKey: { win: "Ctrl-Enter", mac: "Command-Enter" },
    exec: function () {
        executeSql();
    }
});

editor.commands.addCommand({
    name: "newQueryTab",
    bindKey: { win: "Ctrl-Shift-N", mac: "Command-Shift-N" },
    exec: function () {
        createQueryTab("");
    }
});

function refreshSuggestionSelection() {
    var items = autocompleteBox.querySelectorAll(".autocomplete-item");

    items.forEach(function (item, index) {
        item.style.background = index === selectedSuggestionIndex ? "var(--ui-primary-soft, #e8f0fe)" : "var(--ui-surface, #fff)";
    });

    if (items[selectedSuggestionIndex]) {
        items[selectedSuggestionIndex].scrollIntoView({
            block: "nearest"
        });
    }
}

document.addEventListener("click", function (e) {
    if (!autocompleteBox.contains(e.target)) {
        autocompleteBox.style.display = "none";
    }
});


export_query_builder_editor.setTheme("ace/theme/chrome");
export_query_builder_editor.renderer.setShowGutter(false);
export_query_builder_editor.renderer.setShowPrintMargin(false);
export_query_builder_editor.renderer.setPadding(20);
export_query_builder_editor.renderer.setScrollMargin(8, 8, 0, 0);
export_query_builder_editor.setHighlightActiveLine(false);
export_query_builder_editor.getSession().setUseWrapMode(true);
export_query_builder_editor.getSession().setMode("ace/mode/sql");
export_query_builder_editor.setOptions({ maxLines: 15 });
export_query_builder_editor.setFontSize(16);

//Update pager position
$(window).resize(windowResize).scroll(positionFooter);
windowResize();
initializeWorkspacePreferences();

$(".no-propagate").on("click", function (el) { el.stopPropagation(); });

//Check url to load remote DB
var loadUrlDB = $.urlParam('url');
if (loadUrlDB != null) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', decodeURIComponent(loadUrlDB), true);
    xhr.responseType = 'arraybuffer';

    xhr.onload = function (e) {
        var urlName = decodeURIComponent(loadUrlDB).split("/").pop() || "remote.sqlite";
        loadDB(this.response, urlName);
    };
    xhr.onerror = function (e) {
    };
    xhr.send();
}



function loadDB(arrayBuffer, fileName) {
    var nextDatabaseName = normalizeDatabaseFileName(fileName || "database.sqlite");
    var nextDatabaseBytes = arrayBuffer && arrayBuffer.byteLength ? arrayBuffer.byteLength : 0;

    databaseLoadQueue = databaseLoadQueue.then(function () {
        setDatabaseOperationBusy(true);
        showDbProgress("Reading " + nextDatabaseName + "...", 5);

        return new Promise(function (resolve) {
            setTimeout(function () {
                loadDBInternal(arrayBuffer, nextDatabaseName, nextDatabaseBytes, resolve);
            }, 30);
        });
    }).catch(function (error) {
        reportDatabaseOperationError(error, nextDatabaseName);
    }).then(function () {
        setDatabaseOperationBusy(false);
        hideDbProgress();
    });

    return databaseLoadQueue;
}

function loadDBInternal(arrayBuffer, nextDatabaseName, nextDatabaseBytes, done) {

    initSqlJs().then(function (SQL) {
        sqlJsModule = SQL;

        var tables;
        var previousSessionId = activeDatabaseSessionId;

        try {

            showDbProgress("Opening database...", 15);

            suspendActiveDatabaseSession();
            var openedDatabase = new SQL.Database(new Uint8Array(arrayBuffer));
            if (rowEditorState) closeRowEditor();
            if (erCy) closeERDiagram();
            db = openedDatabase;
            loadedDatabaseName = nextDatabaseName;
            loadedDatabaseBytes = nextDatabaseBytes;
            databaseDirty = false;
            activeDatabaseSessionId = createDatabaseSessionId();
            queryTabs = [];
            activeQueryTabId = null;
            databaseSessions.push({
                id: activeDatabaseSessionId,
                name: loadedDatabaseName,
                bytes: loadedDatabaseBytes,
                dirty: false,
                db: db,
                data: null,
                queryTabs: queryTabs,
                activeQueryTabId: activeQueryTabId
            });

            resetActiveDatabaseViewState();
            resetTableList();
            renderDatabaseTabs();
            renderQueryTabs();
            updateDatabaseWorkbenchState();

            showDbProgress("Building schema...", 25);

            buildSchemaSuggestions();

            tables = db.prepare(
                "SELECT * FROM sqlite_master WHERE type='table' OR type='view' ORDER BY UPPER(name)"
            );

        } catch (ex) {

            hideDbProgress();
            restoreDatabaseSessionAfterFailure(previousSessionId, true);
            reportDatabaseOperationError(ex, nextDatabaseName);
            if (done) done();
            return;
        }

        showDbProgress("Reading tables...", 35);

        var firstTableName = null;
        var tableList = $("#tables");

        tableMetaList = [];

        processTablesAsync(
            tables,
            tableList,
            firstTableName,

            function (firstTableName) {

                showDbProgress("Rendering table list...", 85);

                renderTableList();

                $("#table_sort_bar").show();

                setSelectedTableControl(firstTableName);

                if (firstTableName) {
                    doDefaultSelect(firstTableName);
                } else {
                    editor.setValue("", -1);
                    setQueryResultStatus("Database loaded. No tables or views were found.", "warning");
                }

                $("#output-box").fadeIn();

                document.body.classList.add("database-loaded");

                $(".nouploadinfo").hide();

                $("#sample-db-link").hide();

                $("#success-box").show();

                $("#table_list_wrapper").show();

                $("#myInput").show();


                document
                    .getElementById("myInput")
                    .onkeyup = myFunction;

                document.getElementById("myInput").value = "";

                showDbProgress("Done", 100);

                if (loadedDatabaseBytes >= 100 * 1024 * 1024) {
                    setQueryResultStatus(
                        "Large database loaded. Table-size metadata is sampled and query display is capped at " +
                        MAX_RENDERED_ROWS + " rows for responsiveness.",
                        "warning"
                    );
                }

                setTimeout(function () {
                    hideDbProgress();
                    if (done) done();
                }, 300);
            }
        );

    }).catch(function (err) {


        hideDbProgress();
        reportDatabaseOperationError(err, nextDatabaseName);
        if (done) done();
    });
}

function processTablesAsync(tables, tableList, firstTableName, done) {
    while (tables.step()) {
        var rowObj = tables.getAsObject();
        var name = rowObj.name;

        if (firstTableName === null) {
            firstTableName = name;
        }

        tableList.append(
            '<option value="' + name + '">' + name + '</option>'
        );

        tableMetaList.push({
            name: name,
            rows: null,
            columns: null,
            cells: null,
            bytes: null
        });
    }

    if (tables.free) tables.free();
    done(firstTableName);
}

function showDbProgress(message, percent) {

    document.getElementById(
        "db-load-progress"
    ).style.display = "flex";

    document.getElementById(
        "progress-message"
    ).innerText = message || "Loading...";

    document.getElementById(
        "progress-bar-fill"
    ).style.width =
        (percent || 0) + "%";
}

function hideDbProgress() {

    document.getElementById(
        "db-load-progress"
    ).style.display = "none";
}

function waitForPaint(callback) {
    setTimeout(callback, 30);
}

function createCustomCard(table) {
    var safeName = htmlEncode(table.name);
    var encodedName = encodeURIComponent(table.name).replace(/'/g, "%27");

    return `
    <div class="tableNameRow" data-table-name="${encodedName}" onclick="selectTable(decodeURIComponent('${encodedName}'))">
        <div class="table-card-title">${safeName}</div>
        <div class="table-card-meta">
            ${table.rows !== null ? `<span>${table.rows} rows</span>` : ""}
            ${table.columns !== null ? `<span>${table.columns} cols</span>` : ""}
            ${table.bytes !== null ? `<span>${formatBytes(table.bytes)}</span>` : ""}
        </div>
    </div>`;
}

function getTableColumnCount(name) {
    var count = 0;
    var sel = db.prepare("PRAGMA table_info('" + name.replace(/'/g, "''") + "')");
    while (sel.step()) count++;
    return count;
}

function getApproxTableBytes(name) {
    try {
        var total = 0;
        var sampledRows = 0;
        var sampleLimit = 500;
        var escapedName = name.replace(/'/g, "''");
        var sel = db.prepare("SELECT * FROM '" + escapedName + "' LIMIT " + sampleLimit);
        while (sel.step()) {
            var row = sel.get();
            sampledRows++;
            row.forEach(function (v) {
                if (v !== null && v !== undefined) {
                    total += typeof v === "string" ? v.length : String(v).length;
                }
            });
        }

        if (sampledRows === 0) return 0;

        var rowCount = rowCounts[name];
        if (rowCount === undefined || rowCount === null) {
            rowCount = getTableRowsCount(name);
            rowCounts[name] = rowCount;
        }

        return Math.round((total / sampledRows) * Math.max(0, rowCount));
    } catch (e) {
        return 0;
    }
}

function formatBytes(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function renderTableList() {
    var list = tableMetaList.slice();

    if (currentTableSort === "name") {
        list.sort(function (a, b) { return a.name.localeCompare(b.name); });
    } else if (currentTableSort === "rows") {
        list.sort(function (a, b) { return b.rows - a.rows; });
    } else if (currentTableSort === "cells") {
        list.sort(function (a, b) { return b.cells - a.cells; });
    } else if (currentTableSort === "bytes") {
        list.sort(function (a, b) { return b.bytes - a.bytes; });
    }

    var html = "";
    list.forEach(function (table) {
        html += createCustomCard(table);
    });

    document.getElementById("table_list_wrapper").innerHTML = html;

    ["name", "rows", "cells", "bytes"].forEach(function (type) {
        var btn = document.getElementById("sort_" + type);
        if (btn) btn.classList.toggle("active", currentTableSort === type);
    });

    var badge = document.getElementById("table_count_badge");

    if (badge) {
        badge.innerHTML =
            "• " + list.length + " tables";
    }

    var selectedTable = document.getElementById("tableName");
    if (selectedTable && selectedTable.value) {
        highlightSelectedTable(selectedTable.value);
    }
}

function sortTablesBy(type) {
    currentTableSort = type;

    if (type === "name") {
        renderTableList();
        return;
    }

    if (tableSortCache[type]) {
        renderTableList();
        return;
    }

    showDbProgress("Preparing " + type + " sort...", 10);

    setTimeout(function () {
        prepareTableSortData(type, function () {
            tableSortCache[type] = true;
            renderTableList();
            hideDbProgress();
        });
    }, 100);
}

function prepareTableSortData(type, done) {
    var index = 0;
    var batchSize = 2;

    function processBatch() {
        var count = 0;

        while (count < batchSize && index < tableMetaList.length) {
            var table = tableMetaList[index];

            if (type === "rows") {
                table.rows = getTableRowsCount(table.name);
            }

            if (type === "cells") {
                if (table.rows === null) {
                    table.rows = getTableRowsCount(table.name);
                }
                if (table.columns === null) {
                    table.columns = getTableColumnCount(table.name);
                }
                table.cells = table.rows * table.columns;
            }

            if (type === "bytes") {
                table.bytes = getApproxTableBytes(table.name);
            }

            index++;
            count++;
        }

        var percent = Math.floor((index / tableMetaList.length) * 100);

        showDbProgress(
            "Preparing sort data... " + index + " / " + tableMetaList.length,
            percent
        );

        if (index < tableMetaList.length) {
            setTimeout(processBatch, 20);
        } else {
            done();
        }
    }

    processBatch();
}

function selectTable(name) {
    highlightSelectedTable(name);
    doDefaultSelect(name);
    closeMobileSidebar();
}

function highlightSelectedTable(name) {
    var encodedName = encodeURIComponent(name || "").replace(/'/g, "%27");
    document.querySelectorAll(".tableNameRow").forEach(function (row) {
        row.classList.toggle("is-selected", row.getAttribute("data-table-name") === encodedName);
    });
}

function showDbProgress(message, percent) {
    document.getElementById("db-load-progress").style.display = "flex";
    document.getElementById("progress-message").innerText = message || "Loading...";
    document.getElementById("progress-bar-fill").style.width = (percent || 0) + "%";
}

function hideDbProgress() {
    document.getElementById("db-load-progress").style.display = "none";
}

function myFunction() {
    var input = document.getElementById("myInput");
    var filter = input.value.toUpperCase();
    var wrapper = document.getElementById("table_list_wrapper");
    var rows = wrapper.getElementsByClassName("tableNameRow");

    for (var i = 0; i < rows.length; i++) {
        var title = rows[i].getElementsByClassName("table-card-title")[0];

        if (!title) continue;

        var txtValue = title.textContent || title.innerText;

        if (txtValue.toUpperCase().indexOf(filter) > -1) {
            rows[i].style.display = "";
        } else {
            rows[i].style.display = "none";
        }
    }
}

function addRowHandlers() {
    var table = document.getElementById("data");
    var rows = table.getElementsByTagName("tr");
    for (i = 0; i < rows.length; i++) {
        var currentRow = table.rows[i];
        var createClickHandler =
            function (row) {
                return function () {
                    var cell = row.getElementsByTagName("td")[0];
                    var id = cell.innerHTML;
                    alert("id:" + id);
                };
            };

        currentRow.onclick = createClickHandler(currentRow);
    }
}

function getTableRowsCount(name) {
    var sel = db.prepare("SELECT COUNT(*) AS count FROM '" + name + "'");
    if (sel.step()) {
        return sel.getAsObject().count;
    } else {
        return -1;
    }
}

function getQueryRowCount(query) {
    if (query === lastCachedQueryCount.select) {
        return lastCachedQueryCount.count;
    }

    var queryReplaced = query.replace(SQL_SELECT_REGEX, "SELECT COUNT(*) AS count_sv FROM ");

    if (queryReplaced !== query) {
        queryReplaced = queryReplaced.replace(SQL_LIMIT_REGEX, "");
        var sel = db.prepare(queryReplaced);
        if (sel.step()) {
            var count = sel.getAsObject().count_sv;

            lastCachedQueryCount.select = query;
            lastCachedQueryCount.count = count;

            return count;
        } else {
            return -1;
        }
    } else {
        return -1;
    }
}

function getTableColumnTypes(tableName) {
    var result = [];
    var sel = db.prepare("PRAGMA table_info('" + tableName + "')");

    while (sel.step()) {
        var obj = sel.getAsObject();
        result[obj.name] = obj.type;
        /*if (obj.notnull === 1) {
            result[obj.name] += " NOTNULL";
        }*/
    }

    return result;
}



function resetTableList() {
    var tables = $("#tables");
    rowCounts = [];
    tables.off("change");
    tables.empty();
    tables.append("<option></option>");
    tables.select2({
        placeholder: "Select a table",
        formatSelection: selectFormatter,
        formatResult: selectFormatter
    });
    tables.on("change", function (e) {
        if (suppressTableSelectionChange || !e.val) return;
        doDefaultSelect(e.val);
    });
}



function extractFileNameWithoutExt(filename) {
    var dotIndex = filename.lastIndexOf(".");
    if (dotIndex > -1) {
        return filename.substr(0, dotIndex);
    } else {
        return filename;
    }
}

function dropzoneClick() {
    var input = document.getElementById("dropzone-dialog");
    input.value = "";
    input.click();
}

function doDefaultSelect(name) {
    if (!name) return;

    document.getElementById("tableName").value = name;
    setSelectedTableControl(name);

    var pageSizeControl = document.getElementById("page_size");
    var pageSize = pageSizeControl ? parseInt(pageSizeControl.value, 10) : 30;
    if ([30, 50, 100, 250].indexOf(pageSize) === -1) pageSize = 30;
    var defaultSelect = "SELECT * FROM " + quoteSQLiteIdentifier(name) + " LIMIT 0," + pageSize;
    createQueryTab(defaultSelect, name);
}

function setSelectedTableControl(name) {
    if (!name) return;

    highlightSelectedTable(name);

    suppressTableSelectionChange = true;
    try {
        $("#tables").select2("val", name);
    } finally {
        suppressTableSelectionChange = false;
    }
}

function executeSql() {
    var selectedQuery = editor.getSelectedText ? editor.getSelectedText().trim() : "";
    var query = selectedQuery || editor.getValue();

    if (!query || !query.trim()) return;

    var startedAt = Date.now();
    var result = renderQuery(query, false);
    var elapsed = Date.now() - startedAt;

    if (result && result.success) {
        var mutationType = getQueryMutationType(query);

        if (mutationType) {
            markDatabaseDirty(mutationType);

            if (/^(CREATE|DROP|ALTER|REINDEX)$/i.test(mutationType)) {
                refreshDatabaseObjectList();
            }
        }

        addQueryHistory(query, true, elapsed, result.rowCount, result.rowsModified);
        setQueryResultStatus(
            buildQueryResultMessage(result, elapsed),
            result.truncated ? "warning" : "success"
        );
    }

    setSelectedTableControl(getTableNameFromQuery(query));
}

function getTableNameFromQuery(query) {
    var match = String(query || "").match(
        /\bFROM\s+(?:"((?:""|[^"])*)"|'((?:''|[^'])*)'|`([^`]*)`|\[([^\]]+)\]|([^\s,;()]+))/i
    );

    if (!match) return null;

    return (match[1] || match[2] || match[3] || match[4] || match[5] || "")
        .replace(/""/g, '"')
        .replace(/''/g, "'");
}

function parseLimitFromQuery(query, tableName) {
    var sqlRegex = SQL_LIMIT_REGEX.exec(query);
    if (sqlRegex != null) {
        var result = {};

        if (sqlRegex.length > 2 && typeof sqlRegex[2] !== "undefined") {
            result.offset = parseInt(sqlRegex[1]);
            result.max = parseInt(sqlRegex[2]);
        } else {
            result.offset = 0;
            result.max = parseInt(sqlRegex[1]);
        }

        if (result.max == 0) {
            result.pages = 0;
            result.currentPage = 0;
            return result;
        }

        if (typeof tableName === "undefined") {
            tableName = getTableNameFromQuery(query);
        }

        var queryRowsCount = getQueryRowCount(query);
        if (queryRowsCount != -1) {
            result.pages = Math.ceil(queryRowsCount / result.max);
        }
        result.currentPage = Math.floor(result.offset / result.max) + 1;
        result.rowCount = queryRowsCount;

        return result;
    } else {
        return null;
    }
}

function setPage(el, next) {
    if ($(el).hasClass("disabled")) return;

    var query = editor.getValue();
    var limit = parseLimitFromQuery(query);

    var pageToSet;
    if (typeof next !== "undefined") {
        pageToSet = (next ? limit.currentPage : limit.currentPage - 2);
    } else {
        var page = prompt("Go to page");
        if (!isNaN(page) && page >= 1 && page <= limit.pages) {
            pageToSet = page - 1;
        } else {
            return;
        }
    }

    var offset = (pageToSet * limit.max);
    editor.setValue(query.replace(SQL_LIMIT_REGEX, "LIMIT " + offset + "," + limit.max), -1);

    executeSql();
}

function setPageSize(value) {
    var size = parseInt(value, 10);
    if ([30, 50, 100, 250].indexOf(size) === -1) return;

    var query = editor.getValue();
    if (!/^\s*SELECT\b/i.test(query)) return;

    if (SQL_LIMIT_REGEX.test(query)) {
        query = query.replace(SQL_LIMIT_REGEX, "LIMIT 0," + size);
    } else {
        query = query.replace(/;\s*$/, "") + " LIMIT 0," + size;
    }

    editor.setValue(query, -1);
    executeSql();
}

function setTableDensity(value) {
    var density = value === "comfortable" ? "comfortable" : "compact";
    document.body.classList.toggle("table-density-comfortable", density === "comfortable");
    document.body.classList.toggle("table-density-compact", density === "compact");

    var select = document.getElementById("table_density");
    if (select) select.value = density;

    try {
        localStorage.setItem("sqlite-viewer-table-density", density);
    } catch (ignore) {}
}

function initializeWorkspacePreferences() {
    var density = "compact";
    try {
        density = localStorage.getItem("sqlite-viewer-table-density") || density;
    } catch (ignore) {}
    setTableDensity(density);
}

function refreshPagination(query, tableName) {
    var limit = parseLimitFromQuery(query, tableName);
    if (limit !== null && limit.pages > 0) {

        var pager = $("#pager");
        pager.attr("title", "Row count: " + limit.rowCount);
        pager.tooltip('fixTitle');
        pager.text(limit.currentPage + " / " + limit.pages);

        var pageSize = document.getElementById("page_size");
        if (pageSize && [30, 50, 100, 250].indexOf(limit.max) !== -1) {
            pageSize.value = String(limit.max);
        }

        var firstRow = limit.rowCount > 0 ? limit.offset + 1 : 0;
        var lastRow = Math.min(limit.offset + limit.max, limit.rowCount);
        $("#result_range").text("Rows " + firstRow + "–" + lastRow + " of " + limit.rowCount);

        if (limit.currentPage <= 1) {
            $("#page-prev").addClass("disabled");
        } else {
            $("#page-prev").removeClass("disabled");
        }

        if ((limit.currentPage + 1) > limit.pages) {
            $("#page-next").addClass("disabled");
        } else {
            $("#page-next").removeClass("disabled");
        }

        $("#bottom-bar").show();
    } else {
        $("#result_range").text("");
        $("#bottom-bar").hide();
    }
}

function showError(msg) {
    $("#data").hide();
    $("#bottom-bar").hide();
    errorBox.show();
    errorBox.text(msg);
}

function htmlEncode(value) {
    return $('<div/>').text(value).html();
}

function renderQuery(query, isDefualtOrder) {
    var dataBox = $("#data");
    var thead = dataBox.find("thead").find("tr");
    var tbody = dataBox.find("tbody");

    thead.empty();
    tbody.empty();
    errorBox.hide();
    dataBox.show();

    var columnTypes = [];
    var tableName = getTableNameFromQuery(query);
    if (tableName != null) {
        columnTypes = getTableColumnTypes(tableName);
    }

    var sel;
    try {
        sel = db.prepare(query);
    } catch (ex) {
        showError(ex);
        setQueryResultStatus(String(ex), "warning");
        return { success: false, error: ex };
    }

    var hasCurrentRow = false;

    try {
        // Step once before reading metadata. Older sql.js builds expose column
        // names only after the statement has started executing.
        hasCurrentRow = sel.step();
    } catch (executionError) {
        if (sel.free) sel.free();
        showError(executionError);
        setQueryResultStatus(String(executionError), "warning");
        updateRowEditingControls();
        return { success: false, error: executionError };
    }

    var columnNames = sel.getColumnNames ? sel.getColumnNames() : [];

    // This sql.js version also returns no metadata for an empty result. For the
    // common editable SELECT * case, recover the header from SQLite's schema.
    if (columnNames.length === 0 && /^\s*SELECT\b/i.test(query)) {
        var emptyResultTable = extractEditableTableName(query);
        if (emptyResultTable) {
            var emptyResultTableEscaped = emptyResultTable.replace(/'/g, "''");
            var emptyResultColumns = db.prepare("PRAGMA table_info('" + emptyResultTableEscaped + "')");
            while (emptyResultColumns.step()) {
                columnNames.push(emptyResultColumns.getAsObject().name);
            }
            if (emptyResultColumns.free) emptyResultColumns.free();
        }
    }
    var rowsHtml = [];
    var rowCount = 0;
    var truncated = false;
    var orderByColumn = document.getElementById("orderByColumn").value;
    currentResultRows = [];
    currentEditableContext = getEditableTableContext(query, columnNames);

    visibleColumns = {};
    currentColumnNames = columnNames.slice();
    pinnedColumns = {};

    columnNames.forEach(function (columnName) {
        visibleColumns[columnName] = true;
    });

    if (columnNames.length > 0 && isDefualtOrder) {
        orderByColumn = columnNames[0];
    }

    for (var headerIndex = 0; headerIndex < columnNames.length; headerIndex++) {
        var type = columnTypes[columnNames[headerIndex]];
        var indicater = "";

        if (orderByColumn == columnNames[headerIndex] && !isDefualtOrder) {
            indicater = orderByName == "ASC" ? "˄" : "˅";
        }

        thead.append(createTableHeader(columnNames[headerIndex], type, indicater));
    }

    if (currentEditableContext) {
        thead.append('<th class="row-action-cell">Actions</th>');
    }

    try {
        while (hasCurrentRow) {
            if (rowCount >= MAX_RENDERED_ROWS) {
                truncated = true;
                break;
            }

            var values = sel.get();
            var rowObject = {};
            var rowHtml = "<tr>";

            for (var valueIndex = 0; valueIndex < values.length; valueIndex++) {
                rowObject[columnNames[valueIndex]] = values[valueIndex];
                rowHtml += createTableCell(htmlEncode(values[valueIndex]), values[valueIndex], columnNames[valueIndex]);
            }

            currentResultRows.push(rowObject);

            if (currentEditableContext) {
                rowHtml += createRowActionCell(rowCount);
            }

            rowHtml += "</tr>";
            rowsHtml.push(rowHtml);
            rowCount++;
            hasCurrentRow = sel.step();
        }
    } catch (executionError) {
        if (sel.free) sel.free();
        showError(executionError);
        setQueryResultStatus(String(executionError), "warning");
        updateRowEditingControls();
        return { success: false, error: executionError };
    }

    if (sel.free) sel.free();
    tbody.html(rowsHtml.join(""));

    if (columnNames.length > 0 && /^\s*SELECT\b/i.test(query)) {
        try {
            refreshPagination(query, tableName);
        } catch (paginationError) {
            $("#bottom-bar").hide();
        }
    } else {
        $("#bottom-bar").hide();
    }

    $('[data-toggle="tooltip"]').tooltip({ html: true });
    updateRowEditingControls();

    setTimeout(function () {
        positionFooter();
    }, 100);

    applyColumnVisibility();
    applyPinnedColumns();

    return {
        success: true,
        rowCount: rowCount,
        rowsModified: columnNames.length === 0 && db.getRowsModified ? db.getRowsModified() : 0,
        truncated: truncated
    };
}

function createTableHeader(name, type, indicater) {
    var sortIcon;

    if (indicater === "˄") {
        sortIcon = "&#9650;";
    } else if (indicater === "˅") {
        sortIcon = "&#9660;";
    } else {
        sortIcon = "&#8597;";
    }

    var isActive = indicater !== "";
    var isPinned = pinnedColumns[name] === true;

    var sortClass = isActive ? "header-icon-btn active-sort-btn" : "header-icon-btn";
    var pinClass = isPinned ? "header-icon-btn active-pin-btn" : "header-icon-btn";
    var safeName = htmlEncode(name);
    var safeType = htmlEncode(type || "");
    var encodedName = encodeURIComponent(name).replace(/'/g, "%27");
    var encodedType = encodeURIComponent(type || "").replace(/'/g, "%27");

    const content = `
    <th style="white-space:nowrap;" data-column-name="${safeName}">
        <div class="table-header-toolbar">
            <span data-toggle="tooltip" data-placement="top" title="${safeType}">${safeName}</span>

            <div class="table-header-actions">
                <button onclick="orderBy(decodeURIComponent('${encodedName}'),decodeURIComponent('${encodedType}'))"
                        class="${sortClass}"
                        title="Sort by ${safeName}">
                    ${sortIcon}
                </button>

                <button onclick="togglePinColumn(decodeURIComponent('${encodedName}'))"
                        class="${pinClass}"
                        title="Pin / Unpin column">
                    📌
                </button>
            </div>
        </div>

        <input type="hidden" value="${safeName}">
    </th>
  `;

    return content;
}

function togglePinColumn(columnName) {
    pinnedColumns[columnName] = !pinnedColumns[columnName];
    applyPinnedColumns();
}

function applyPinnedColumns() {

    var table = document.getElementById("data");

    if (!table) return;

    var leftOffset = 0;

    currentColumnNames.forEach(function (col, index) {

        var pinned = pinnedColumns[col] === true;

        var header =
            table.querySelector("thead tr").children[index];

        var rows =
            table.querySelectorAll("tbody tr");

        if (header) {
            header.classList.remove("sticky-column");
            header.style.left = "";
        }

        rows.forEach(function (row) {

            if (row.children[index]) {
                row.children[index].classList.remove("sticky-column");
                row.children[index].style.left = "";
            }
        });

        if (pinned && header) {

            var width = header.offsetWidth;

            header.classList.add("sticky-column");
            header.style.left = leftOffset + "px";

            rows.forEach(function (row) {

                if (row.children[index]) {

                    row.children[index].classList.add("sticky-column");

                    row.children[index].style.left =
                        leftOffset + "px";
                }
            });

            leftOffset += width;
        }
    });
}

function createTableCell(data, rowValue, columnName) {
    var safeValue = String(rowValue == null ? "" : rowValue);
    var safeColumn = String(columnName == null ? "" : columnName);

    return '<td class="data-cell" title="' + htmlEncode(safeValue) + '">' +
        '<span class="cell-copy-value" onclick="copyCellValue(event, this)" data-value="' + htmlEncode(safeValue) + '">' +
        data +
        '</span>' +
        '<button class="where-search-btn" title="Use in WHERE" onclick="event.stopPropagation(); selectValue(\'' +
        safeColumn.replace(/'/g, "\\'") +
        '\', this.previousElementSibling.getAttribute(\'data-value\'))">🔍</button>' +
        '</td>';
}

function copyCellValue(event, el) {
    var value = el.getAttribute("data-value") || "";

    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(value).then(function () {
            showToast("Copied", event.clientX, event.clientY);
        }).catch(function () {
            fallbackCopyText(value);
        });
    } else {
        fallbackCopyText(value);
    }
}

function fallbackCopyText(value) {
    var textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();

    try {
        document.execCommand("copy");
        showToast("Copied: " + value);
    } catch (err) {
        showToast("Copy failed");
    }

    document.body.removeChild(textarea);
}

function showToast(message, x, y) {
    var toast = document.getElementById("copy-toast");

    if (!toast) {
        toast = document.createElement("div");
        toast.id = "copy-toast";

        toast.style.position = "fixed";
        toast.style.background = "#222";
        toast.style.color = "#fff";
        toast.style.padding = "8px 12px";
        toast.style.borderRadius = "6px";
        toast.style.zIndex = "999999";
        toast.style.fontSize = "13px";
        toast.style.pointerEvents = "none";
        toast.style.boxShadow = "0 3px 10px rgba(0,0,0,0.25)";
        toast.style.transition = "opacity 0.15s ease";

        document.body.appendChild(toast);
    }

    toast.innerText = message;

    toast.style.left = (x + 12) + "px";
    toast.style.top = (y + 12) + "px";

    toast.style.display = "block";
    toast.style.opacity = "1";

    clearTimeout(window.copyToastTimeout);

    window.copyToastTimeout = setTimeout(function () {
        toast.style.opacity = "0";

        setTimeout(function () {
            toast.style.display = "none";
        }, 150);
    }, 1200);
}

function orderBy(name, type) {
    var tableName = document.getElementById("tableName").value;
    var tableIdentifier = quoteSQLiteIdentifier(tableName);
    var columnIdentifier = quoteSQLiteIdentifier(name);
    var normalizedType = String(type || "").toUpperCase();
    document.getElementById("orderByColumn").value = name;

    if (orderByName == "ASC") {
        orderByName = "DESC";
    } else {
        orderByName = "ASC";
    }
    if (/INT/.test(normalizedType)) {
        editor.setValue("SELECT * FROM " + tableIdentifier + " ORDER BY CAST(" + columnIdentifier + " AS INTEGER) " + orderByName + " LIMIT 100");
    } else if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(normalizedType)) {
        editor.setValue("SELECT * FROM " + tableIdentifier + " ORDER BY CAST(" + columnIdentifier + " AS REAL) " + orderByName + " LIMIT 100");
    } else {
        editor.setValue("SELECT * FROM " + tableIdentifier + " ORDER BY UPPER(" + columnIdentifier + ") " + orderByName + " LIMIT 100");
    }

    executeSql();
}

function selectValue(columnName, rowValue) {
    var tableName = document.getElementById("tableName").value
    editor.setValue("SELECT * FROM " + tableName + " WHERE " + columnName + " = '" + rowValue + "'");


}

function keyPressEvent() {
    document.getElementById("myInput").dispatchEvent(new KeyboardEvent('keydown', { 'key': 'a' }));
}

function openSelectCoulmnsList() {
    document.getElementById("query_build_popup").style.display = "inline";
    var tableName = getTableNameFromQuery(editor.getValue()) || document.getElementById("tableName").value;
    export_query_builder_editor.setValue("SELECT * FROM '" + tableName + "'");

    var sel;
    try {
        sel = db.prepare("SELECT * FROM '" + tableName + "' LIMIT 1");
    } catch (ex) {
        showError(ex);
        return;
    }
    var addedColums = false;
    var htmlCode = ""
    while (sel.step()) {
        if (!addedColums) {
            addedColums = true;
            visibleColumns = {};
            currentColumnNames = [];
            pinnedColumns = {};
            var columnNames = sel.getColumnNames();
            for (var i = 0; i < columnNames.length; i++) {
                htmlCode += culumnCheckBuilder(columnNames[i]);
            }
        }


    }
    document.getElementById("column_chck_box").innerHTML = htmlCode;

    // Remove old listeners by cloning and replacing export buttons
    ["confirm_export_sql", "confirm_export_json", "confirm_export_csv", "confirm_export_xml", "confirm_export_excel"].forEach(function (id) {
        var old = document.getElementById(id);
        var fresh = old.cloneNode(true);
        old.parentNode.replaceChild(fresh, old);
    });

    var checkboxes = document.querySelectorAll("input[type=checkbox][name=export_columns]");
    let enabledSettings = Array.from(checkboxes).map(i => i.value);
    var currentTableName = document.getElementById("tableName").value



    checkboxes.forEach(function (checkbox) {
        checkbox.addEventListener('change', function () {
            enabledSettings =
                Array.from(checkboxes) // Convert checkboxes to an array to use filter and map.
                    .filter(i => i.checked) // Use Array.filter to remove unchecked checkboxes.
                    .map(i => i.value) // Use Array.map to extract only the checkbox values from the array of objects.

            export_query_builder_editor.setValue("SELECT " + enabledSettings.toString() + " FROM " + currentTableName);

        })
    });

    enabledSettings = Array.from(checkboxes) // Convert checkboxes to an array to use filter and map.
        .filter(i => i.checked) // Use Array.filter to remove unchecked checkboxes.
        .map(i => i.value) // Use Array.map to extract only the checkbox values from the array of objects.

    export_query_builder_editor.setValue("SELECT " + enabledSettings.toString() + " FROM " + currentTableName);


    document.getElementById("confirm_export_sql").addEventListener("click", function () {
        exportToSQL(enabledSettings);
    });

    document.getElementById("confirm_export_csv").addEventListener("click", function () {
        exportToCSV(enabledSettings);
    });

    document.getElementById("confirm_export_xml").addEventListener("click", function () {
        exportToXML(enabledSettings);
    });

    document.getElementById("confirm_export_json").addEventListener("click", function () {
        exportToJSON(enabledSettings);
    });

    document.getElementById("confirm_export_excel").addEventListener("click", function () {
        exportToExcel(enabledSettings);
    });
}

function culumnCheckBuilder(columnName) {
    const content = `
    <input type="checkbox" id="'${columnName}'" name="export_columns" value="${columnName}" checked>
    <label for="'${columnName}'">${columnName}</label><br>

  `;
    return content;
}

function dismissColumnSelectDialog() {
    document.getElementById("query_build_popup").style.display = "none";

}

function buildInsertQuery(columnNames) {
    var tableName = document.getElementById("tableName").value
    console.log("tableName = <" + tableName + ">")
    var sel;
    try {
        sel = db.prepare(export_query_builder_editor.getValue());
    } catch (ex) {
        showError(ex);
        return;
    }
    var addedColums = false;
    var baseQuery = "INSERT INTO " + tableName + " ("
    var queryPreFix = ""
    while (sel.step()) {

        if (!addedColums) {
            addedColums = true;
            var columnString = "";
            var columnPreFix = ""
            for (var i = 0; i < columnNames.length; i++) {
                columnString += columnPreFix;
                columnPreFix = ","
                columnString += columnNames[i]
            }
            baseQuery += columnString + ") VALUES "
        }


        var valuePreFix = ""
        var valueQuery = "";
        var s = sel.get();
        for (var i = 0; i < s.length; i++) {
            valueQuery += valuePreFix;
            valuePreFix = ","
            valueQuery += "'" + s[i] + "'";
            // tr.append('<td><span title="' + htmlEncode(s[i]) + '">' + htmlEncode(s[i]) + '</span></td>');
        }
        baseQuery += queryPreFix;
        queryPreFix = ","
        baseQuery += "\n("
        baseQuery += valueQuery;
        baseQuery += ")"

    }
    download(tableName + ".sql", baseQuery, type = "text/plain")
    document.getElementById("query_build_popup").style.display = "none";
}

function getExportFileName(tableName, ext) {
    var now = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    var datePart = now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate());
    var timePart = pad(now.getHours()) + '-' + pad(now.getMinutes()) + '-' + pad(now.getSeconds());
    var safeName = (tableName || 'export').replace(/[\/\:*?"<>|]/g, '_');
    return safeName + '_' + datePart + ' ' + timePart + '.' + ext;
}

function exportToSQL(columnNames) {
    var tableName = document.getElementById("tableName").value

    var result = buildInsertQuery2(columnNames);


    var insertQuery = 'INSERT INTO ' + tableName + ' (';
    var values = [];

    // Get the column names from the first row of the result array
    var columnNames = Object.keys(result[0]);
    insertQuery += columnNames.join(', ');

    result.forEach(function (row) {
        var rowValues = columnNames.map(function (column) {
            return "'" + row[column] + "'";
        });
        var rowString = '(' + rowValues.join(', ') + ')\n';
        values.push(rowString);
    });

    insertQuery += ') VALUES \n';
    insertQuery += values.join(', ');
    download(getExportFileName(tableName, 'sql'), insertQuery, type = "text/plain")

    console.log(insertQuery);

}

function buildInsertQuery2(columnNames) {

    var sel;
    try {
        sel = db.prepare(export_query_builder_editor.getValue());
    } catch (ex) {
        showError(ex);
        return;
    }

    var dataArray = [];
    var addedColumns = false;

    while (sel.step()) {
        if (!addedColumns) {
            addedColumns = true;
        }

        var row = {};
        var values = sel.get();

        for (var i = 0; i < columnNames.length; i++) {
            var columnName = columnNames[i];
            var value = values[i];
            row[columnName] = value;
        }

        dataArray.push(row);
    }

    console.log(dataArray);
    return dataArray;
}

function pragma() {
    var tableName = document.getElementById("tableName").value

    export_query_builder_editor.setValue("PRAGMA table_info(" + tableName + ")");

    editor.setValue("PRAGMA table_info(" + tableName + ")");

    executeSql();
}



function exportToCSV(columnNames) {
    var result = buildInsertQuery2(columnNames);

    if (!result || result.length === 0) return;

    var csvContent = 'data:text/csv;charset=utf-8,';

    // Add headers row
    var headers = Object.keys(result[0]).map(function (h) { return '"' + h + '"'; });
    csvContent += headers.join(',') + '\n';

    // Generate the CSV content
    result.forEach(function (row) {
        var rowValues = Object.values(row).map(function (value) {
            return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
        });
        var rowString = rowValues.join(',');
        csvContent += rowString + '\n';
    });

    // Create a download link for the CSV file
    var encodedUri = encodeURI(csvContent);
    var link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', getExportFileName(getTableNameFromQuery(export_query_builder_editor.getValue()), 'csv'));
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function exportToXML(columnNames) {
    var result = buildInsertQuery2(columnNames);

    var xmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xmlContent += '<root>\n';

    // Generate the XML content
    result.forEach(function (row) {
        xmlContent += '  <row>\n';

        Object.keys(row).forEach(function (column) {
            xmlContent += '    <' + column + '>' + row[column] + '</' + column + '>\n';
        });

        xmlContent += '  </row>\n';
    });

    xmlContent += '</root>';

    // Create a download link for the XML file
    var encodedUri = encodeURI('data:text/xml;charset=utf-8,' + xmlContent);
    var link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', getExportFileName(getTableNameFromQuery(export_query_builder_editor.getValue()), 'xml'));
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function exportToJSON(columnNames) {
    var result = buildInsertQuery2(columnNames);

    var jsonContent = JSON.stringify(result, null, 2);

    // Create a download link for the JSON file
    var encodedUri = encodeURI('data:application/json;charset=utf-8,' + jsonContent);
    var link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', getExportFileName(getTableNameFromQuery(export_query_builder_editor.getValue()), 'json'));
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
}

function exportToExcel(columnNames) {
    var result = buildInsertQuery2(columnNames);
    if (!result || result.length === 0) return;

    var tableName = getTableNameFromQuery(export_query_builder_editor.getValue()) || 'export';
    var ws = XLSX.utils.json_to_sheet(result);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tableName.substring(0, 31));
    XLSX.writeFile(wb, getExportFileName(tableName, 'xlsx'));
}

function excelImportClick() {
    document.getElementById("excel-import-dialog").click();
}

function importExcelFile(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
        try {
            var data = new Uint8Array(e.target.result);
            var workbook = XLSX.read(data, { type: 'array' });

            var sqlStatements = '';
            workbook.SheetNames.forEach(function (sheetName) {
                var ws = workbook.Sheets[sheetName];
                var rows = XLSX.utils.sheet_to_json(ws, { defval: null });
                if (!rows || rows.length === 0) return;

                var safeName = sheetName.replace(/[^a-zA-Z0-9_]/g, '_');
                var cols = Object.keys(rows[0]);

                sqlStatements += 'DROP TABLE IF EXISTS "' + safeName + '";\n';
                sqlStatements += 'CREATE TABLE "' + safeName + '" (\n  ';
                sqlStatements += cols.map(function (c) { return '"' + c + '" TEXT'; }).join(',\n  ');
                sqlStatements += '\n);\n';

                rows.forEach(function (row) {
                    var vals = cols.map(function (c) {
                        var v = row[c];
                        if (v === null || v === undefined) return 'NULL';
                        return "'" + String(v).replace(/'/g, "''") + "'";
                    });
                    sqlStatements += 'INSERT INTO "' + safeName + '" VALUES (' + vals.join(', ') + ');\n';
                });
                sqlStatements += '\n';
            });

            initSqlJs().then(function (SQL) {
                sqlJsModule = SQL;
                try {
                    var createdDatabase = !db;
                    if (createdDatabase) {
                        captureActiveDatabaseSession();
                        db = new SQL.Database();
                        loadedDatabaseName = normalizeDatabaseFileName(
                            extractFileNameWithoutExt(file.name || "excel_import") + ".sqlite"
                        );
                        loadedDatabaseBytes = 0;
                        activeDatabaseSessionId = createDatabaseSessionId();
                        queryTabs = [];
                        activeQueryTabId = null;
                        databaseSessions.push({
                            id: activeDatabaseSessionId,
                            name: loadedDatabaseName,
                            bytes: 0,
                            dirty: true,
                            db: db,
                            queryTabs: queryTabs,
                            activeQueryTabId: activeQueryTabId
                        });
                        resetActiveDatabaseViewState();
                        renderDatabaseTabs();
                    }
                    db.run(sqlStatements);

                    databaseDirty = true;
                    lastCachedQueryCount = {};
                    buildSchemaSuggestions();

                    resetTableList();
                    var tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='view' ORDER BY UPPER(name)");
                    var firstTableName = null;
                    var tableList = $("#tables");
                    var letters = '';
                    while (tables.step()) {
                        var rowObj = tables.getAsObject();
                        var name = rowObj.name;
                        if (!firstTableName) firstTableName = name;
                        var rowCount = getTableRowsCount(name);
                        rowCounts[name] = rowCount;
                        tableList.append('<option value="' + name + '">' + name + ' (' + rowCount + ' rows)</option>');
                        letters += createCustomCard({
                            name: name,
                            rows: rowCount,
                            columns: null,
                            cells: null,
                            bytes: null
                        });
                    }
                    document.getElementById('table_list_wrapper').innerHTML = letters;
                    setSelectedTableControl(firstTableName);
                    doDefaultSelect(firstTableName);

                    $("#output-box").fadeIn();
                    document.body.classList.add("database-loaded");
                    $(".nouploadinfo").hide();
                    $("#sample-db-link").hide();
                    $("#table_list_wrapper").show();
                    $("#myInput").show();
                    document.getElementById("myInput").onkeyup = myFunction;
                    document.getElementById("myInput").value = "";
                    updateDatabaseWorkbenchState();
                    setQueryResultStatus(
                        "Excel import completed. Download the database to save the changes.",
                        "success"
                    );
                } catch (ex) {
                    alert("Error importing Excel: " + ex);
                } finally {

                }
            });
        } catch (ex) {
            alert("Failed to read Excel file: " + ex);
        }
    };
    reader.readAsArrayBuffer(file);
}

function download(filename, text, type = "text/plain") {
    // Create an invisible A element
    const a = document.createElement("a");
    a.style.display = "none";
    document.body.appendChild(a);

    // Set the HREF to a Blob representation of the data to be downloaded
    a.href = window.URL.createObjectURL(
        new Blob([text], { type })
    );

    // Use download attribute to set set desired file name
    a.setAttribute("download", filename);

    // Trigger the download by simulating click
    a.click();

    // Cleanup
    window.URL.revokeObjectURL(a.href);
    document.body.removeChild(a);
}

function normalizeDatabaseFileName(fileName) {
    var name = String(fileName || "database.sqlite").split(/[\\/]/).pop();
    name = name.replace(/[^A-Za-z0-9._ -]/g, "_");

    if (!/\.(sqlite|sqlite3|db|db3)$/i.test(name)) {
        name += ".sqlite";
    }

    return name || "database.sqlite";
}

function createDatabaseSessionId() {
    return "database_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

function getActiveDatabaseSession() {
    return databaseSessions.filter(function (session) {
        return session.id === activeDatabaseSessionId;
    })[0] || null;
}

function captureActiveDatabaseSession() {
    var session = getActiveDatabaseSession();
    if (!session) return;

    session.db = db;
    session.name = loadedDatabaseName;
    session.bytes = loadedDatabaseBytes;
    session.dirty = databaseDirty;
    session.queryTabs = queryTabs;
    session.activeQueryTabId = activeQueryTabId;
}

function setDatabaseOperationBusy(isBusy) {
    databaseOperationInProgress = !!isBusy;
    var tabs = document.getElementById("database_tabs");

    if (tabs) {
        tabs.classList.toggle("is-busy", databaseOperationInProgress);
        tabs.setAttribute("aria-busy", databaseOperationInProgress ? "true" : "false");
    }
}

function reportDatabaseOperationError(error, databaseName) {
    var text = String(error && error.message ? error.message : error || "Unknown database error");
    var isOutOfMemory = /\bOOM\b|out of memory|Cannot enlarge memory/i.test(text);
    var message = isOutOfMemory
        ? "Not enough browser memory to open " + databaseName + ". Close another database or use a smaller file."
        : "Could not open " + databaseName + ": " + text;

    console.error(error);
    hideDbProgress();
    setQueryResultStatus(message, "warning");
}

function suspendActiveDatabaseSession() {
    var session = getActiveDatabaseSession();
    if (!session || !db) return session;

    captureActiveDatabaseSession();

    if (session.dirty || !session.data) {
        session.data = db.export();
        session.bytes = session.data.length;
    }

    if (db.close) db.close();
    session.db = null;
    db = null;
    return session;
}

function activateDatabaseSessionState(session) {
    if (!session) throw new Error("Database session was not found.");
    if (!sqlJsModule) throw new Error("SQLite runtime is not ready.");
    if (!session.data) throw new Error("Database bytes are unavailable.");

    db = new sqlJsModule.Database(session.data);
    session.data = null;
    session.db = db;
    activeDatabaseSessionId = session.id;
    loadedDatabaseName = session.name;
    loadedDatabaseBytes = session.bytes;
    databaseDirty = !!session.dirty;
    queryTabs = Array.isArray(session.queryTabs) ? session.queryTabs : [];
    activeQueryTabId = session.activeQueryTabId;

    if (queryTabs.length > 0 && !queryTabs.some(function (tab) { return tab.id === activeQueryTabId; })) {
        activeQueryTabId = queryTabs[0].id;
    } else if (queryTabs.length === 0) {
        activeQueryTabId = null;
    }
}

function restoreDatabaseSessionAfterFailure(previousSessionId, discardCurrentSession) {
    if (activeDatabaseSessionId === previousSessionId && db) {
        var stillActiveSession = getActiveDatabaseSession();
        if (stillActiveSession) stillActiveSession.db = db;
        renderDatabaseTabs();
        updateDatabaseWorkbenchState();
        return;
    }

    var currentIndex = databaseSessions.findIndex(function (session) {
        return session.id === activeDatabaseSessionId && session.id !== previousSessionId;
    });

    if (currentIndex >= 0) {
        var currentSession = databaseSessions[currentIndex];
        if (currentSession.db && currentSession.db.close) currentSession.db.close();
        currentSession.db = null;

        if (discardCurrentSession) {
            databaseSessions.splice(currentIndex, 1);
        }
    }

    db = null;
    activeDatabaseSessionId = null;
    var previousSession = databaseSessions.filter(function (session) {
        return session.id === previousSessionId;
    })[0];

    if (!previousSession) {
        showEmptyDatabaseWorkspace();
        return;
    }

    try {
        activateDatabaseSessionState(previousSession);
        resetActiveDatabaseViewState();
        rebuildActiveDatabaseInterface();
    } catch (restoreError) {
        console.error("Could not restore the previous database", restoreError);
        showEmptyDatabaseWorkspace();
    }
}

function resetActiveDatabaseViewState() {
    currentTableSort = "name";
    tableSortCache = { rows: false, cells: false, bytes: false };
    tableMetaList = [];
    rowCounts = [];
    lastCachedQueryCount = {};
    schemaSuggestions = [];
    schemaLoaded = false;
    currentResultRows = [];
    currentEditableContext = null;
    currentColumnNames = [];
    visibleColumns = {};
    pinnedColumns = {};
}

function enableTabReorder(button, items, index, onReorder) {
    button.draggable = true;

    button.addEventListener("dragstart", function (event) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", String(index));
        button.classList.add("tab-dragging");
    });

    button.addEventListener("dragend", function () {
        button.classList.remove("tab-dragging");
        var marked = document.querySelectorAll(".tab-drop-before, .tab-drop-after");
        for (var i = 0; i < marked.length; i++) {
            marked[i].classList.remove("tab-drop-before", "tab-drop-after");
        }
    });

    button.addEventListener("dragover", function (event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        var rect = button.getBoundingClientRect();
        var after = event.clientX > rect.left + rect.width / 2;
        button.classList.toggle("tab-drop-after", after);
        button.classList.toggle("tab-drop-before", !after);
    });

    button.addEventListener("dragleave", function () {
        button.classList.remove("tab-drop-before", "tab-drop-after");
    });

    button.addEventListener("drop", function (event) {
        event.preventDefault();
        var from = parseInt(event.dataTransfer.getData("text/plain"), 10);
        var rect = button.getBoundingClientRect();
        var to = index + (event.clientX > rect.left + rect.width / 2 ? 1 : 0);
        button.classList.remove("tab-drop-before", "tab-drop-after");
        if (isNaN(from) || from < 0 || from >= items.length) return;
        var moved = items.splice(from, 1)[0];
        if (from < to) to--;
        items.splice(to, 0, moved);
        onReorder();
    });
}

function renderDatabaseTabs() {
    var container = document.getElementById("database_tabs");
    if (!container) return;
    container.innerHTML = "";

    databaseSessions.forEach(function (session, sessionIndex) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "database-tab" + (session.id === activeDatabaseSessionId ? " active" : "");
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", session.id === activeDatabaseSessionId ? "true" : "false");
        button.title = session.name;
        button.addEventListener("click", function () { switchDatabaseSession(session.id); });

        if (session.dirty) {
            var dirtyMarker = document.createElement("span");
            dirtyMarker.className = "database-tab-dirty";
            dirtyMarker.title = "Modified";
            button.appendChild(dirtyMarker);
        }

        var name = document.createElement("span");
        name.className = "database-tab-name";
        name.textContent = session.name;
        button.appendChild(name);

        var closeButton = document.createElement("span");
        closeButton.className = "database-tab-close";
        closeButton.textContent = "\u00d7";
        closeButton.setAttribute("aria-label", "Close " + session.name);
        closeButton.addEventListener("click", function (event) {
            closeDatabaseSession(event, session.id);
        });
        button.appendChild(closeButton);
        enableTabReorder(button, databaseSessions, sessionIndex, renderDatabaseTabs);
        container.appendChild(button);
    });

    var openDatabaseButton = document.createElement("button");
    openDatabaseButton.type = "button";
    openDatabaseButton.className = "query-tab-new database-tab-new";
    openDatabaseButton.textContent = "+";
    openDatabaseButton.title = "Open database";
    openDatabaseButton.setAttribute("aria-label", "Open database");
    openDatabaseButton.addEventListener("click", dropzoneClick);
    container.appendChild(openDatabaseButton);
}

function switchDatabaseSession(sessionId) {
    if (sessionId === activeDatabaseSessionId || databaseOperationInProgress) return;

    if (rowEditorState) closeRowEditor();
    if (erCy) closeERDiagram();
    var previousSessionId = activeDatabaseSessionId;
    var session = databaseSessions.filter(function (item) { return item.id === sessionId; })[0];
    if (!session) return;

    setDatabaseOperationBusy(true);

    try {
        suspendActiveDatabaseSession();
        activateDatabaseSessionState(session);
        resetActiveDatabaseViewState();
        rebuildActiveDatabaseInterface();
    } catch (error) {
        restoreDatabaseSessionAfterFailure(previousSessionId, false);
        reportDatabaseOperationError(error, session.name);
    } finally {
        hideDbProgress();
        setDatabaseOperationBusy(false);
    }
}

function rebuildActiveDatabaseInterface() {
    if (!db) return;

    document.body.classList.add("database-loaded");

    resetTableList();
    buildSchemaSuggestions();

    var tables = db.prepare(
        "SELECT * FROM sqlite_master WHERE type='table' OR type='view' ORDER BY UPPER(name)"
    );
    var tableList = $("#tables");

    processTablesAsync(tables, tableList, null, function (firstTableName) {
        renderTableList();
        $("#table_sort_bar").toggle(!!firstTableName);

        var activeTab = getActiveQueryTab();
        var queryTable = activeTab ? getTableNameFromQuery(activeTab.sql) : null;
        var selectedTable = tableMetaList.some(function (table) { return table.name === queryTable; })
            ? queryTable
            : firstTableName;

        setSelectedTableControl(selectedTable);
        document.getElementById("tableName").value = selectedTable || "";
        renderDatabaseTabs();
        renderQueryTabs();
        hideDbProgress();
        loadActiveQueryTab();
        updateDatabaseWorkbenchState();
        $("#output-box").show();
        $("#table_list_wrapper, #myInput").show();
        document.getElementById("myInput").value = "";
    });
}

function closeDatabaseSession(event, sessionId) {
    if (event) event.stopPropagation();
    captureActiveDatabaseSession();

    var index = databaseSessions.findIndex(function (session) { return session.id === sessionId; });
    if (index < 0) return;

    var session = databaseSessions[index];
    if (session.dirty && !confirm("Close " + session.name + " without downloading the latest changes?")) {
        return;
    }

    var wasActive = session.id === activeDatabaseSessionId;
    if (session.db && session.db.close) session.db.close();
    databaseSessions.splice(index, 1);

    if (!wasActive) {
        renderDatabaseTabs();
        return;
    }

    activeDatabaseSessionId = null;
    db = null;

    if (databaseSessions.length > 0) {
        var nextSession = databaseSessions[Math.min(index, databaseSessions.length - 1)];
        switchDatabaseSession(nextSession.id);
    } else {
        showEmptyDatabaseWorkspace();
    }
}

function showEmptyDatabaseWorkspace() {
    document.body.classList.remove("database-loaded");
    loadedDatabaseName = "database.sqlite";
    loadedDatabaseBytes = 0;
    databaseDirty = false;
    resetActiveDatabaseViewState();
    resetTableList();
    queryTabs = [];
    activeQueryTabId = null;
    renderDatabaseTabs();
    renderQueryTabs();
    loadActiveQueryTab();
    updateDatabaseWorkbenchState();
    $("#output-box").hide();
    $("#table_list_wrapper, #table_sort_bar, #myInput").hide();
    $(".nouploadinfo, #sample-db-link").show();
}

function updateDatabaseWorkbenchState() {
    var status = document.getElementById("database_status");
    var statusText = document.getElementById("database_status_text");
    var hasDatabase = !!db;
    var stateText = "No database loaded";

    if (hasDatabase) {
        stateText = loadedDatabaseName + " · " + formatBytes(loadedDatabaseBytes || 0);

        if (databaseSessions.length > 1) {
            stateText += " · " + databaseSessions.length + " databases open";
        }

        if (databaseDirty) {
            stateText += " · modified";
        } else {
            stateText += " · ready";
        }
    }

    if (statusText) statusText.textContent = stateText;

    if (status) {
        status.classList.toggle("is-clean", hasDatabase && !databaseDirty);
        status.classList.toggle("is-dirty", hasDatabase && databaseDirty);
    }

    var saveButton = document.getElementById("save_database_btn");
    if (saveButton) saveButton.disabled = !hasDatabase;
    captureActiveDatabaseSession();
    renderDatabaseTabs();
}

function markDatabaseDirty(reason) {
    databaseDirty = true;
    lastCachedQueryCount = {};
    updateDatabaseWorkbenchState();

    if (reason) {
        setQueryResultStatus(reason + " completed. Click Save DB to download the latest database.", "success");
    }
}

function saveDatabaseFile() {
    if (!db) return;

    try {
        showDbProgress("Preparing database...", 35);
        var bytes = db.export();
        var fileName = loadedDatabaseName;

        download(fileName, bytes, "application/vnd.sqlite3");
        loadedDatabaseBytes = bytes.length;
        databaseDirty = false;

        var session = getActiveDatabaseSession();
        if (session) {
            session.data = null;
            session.bytes = bytes.length;
            session.dirty = false;
        }

        updateDatabaseWorkbenchState();
        setQueryResultStatus("Latest database downloaded: " + fileName, "success");
    } catch (error) {
        showError(error);
    } finally {
        hideDbProgress();
    }
}

window.addEventListener("beforeunload", function (event) {
    captureActiveDatabaseSession();
    if (!databaseSessions.some(function (session) { return session.dirty; })) return;

    event.preventDefault();
    event.returnValue = "";
});

function quoteSQLiteIdentifier(identifier) {
    return '"' + String(identifier).replace(/"/g, '""') + '"';
}

function extractEditableTableName(query) {
    var match = String(query).match(
        /^\s*SELECT\s+\*\s+FROM\s+(?:"((?:""|[^"])*)"|'((?:''|[^'])*)'|`([^`]*)`|\[([^\]]+)\]|([A-Za-z_][A-Za-z0-9_$]*))/i
    );

    if (!match) return null;

    return (match[1] || match[2] || match[3] || match[4] || match[5] || "")
        .replace(/""/g, '"')
        .replace(/''/g, "'");
}

function getEditableTableContext(query, resultColumns) {
    var tableName = extractEditableTableName(query);

    if (!tableName || /\b(JOIN|UNION|INTERSECT|EXCEPT|GROUP\s+BY|HAVING|DISTINCT)\b/i.test(query)) {
        return null;
    }

    var escapedName = tableName.replace(/'/g, "''");
    var typeStmt = db.prepare(
        "SELECT type FROM sqlite_master WHERE name='" + escapedName + "' LIMIT 1"
    );
    var objectType = typeStmt.step() ? typeStmt.getAsObject().type : null;
    if (typeStmt.free) typeStmt.free();
    if (objectType !== "table") return null;

    var columns = [];
    var columnStmt = db.prepare("PRAGMA table_info('" + escapedName + "')");

    while (columnStmt.step()) {
        var column = columnStmt.getAsObject();
        columns.push({
            name: column.name,
            type: column.type || "",
            notNull: Number(column.notnull) === 1,
            defaultValue: column.dflt_value,
            primaryKeyOrder: Number(column.pk) || 0
        });
    }
    if (columnStmt.free) columnStmt.free();

    if (columns.length !== resultColumns.length) return null;
    for (var i = 0; i < columns.length; i++) {
        if (columns[i].name !== resultColumns[i]) return null;
    }

    return {
        tableName: tableName,
        columns: columns,
        primaryKeys: columns.filter(function (column) {
            return column.primaryKeyOrder > 0;
        }).sort(function (a, b) {
            return a.primaryKeyOrder - b.primaryKeyOrder;
        })
    };
}

function updateRowEditingControls() {
    var addButton = document.getElementById("add_row_btn");
    if (addButton) addButton.style.display = currentEditableContext ? "inline-flex" : "none";
}

function createRowActionCell(rowIndex) {
    if (!currentEditableContext || currentEditableContext.primaryKeys.length === 0) {
        return '<td class="row-action-cell" title="Add a primary key to enable safe row updates">PK required</td>';
    }

    return '<td class="row-action-cell">' +
        '<button class="row-action-btn" type="button" onclick="openEditRowEditor(' + rowIndex + ')">Edit</button>' +
        '<button class="row-action-btn delete" type="button" onclick="deleteResultRow(' + rowIndex + ')">Delete</button>' +
        '</td>';
}

function openAddRowEditor() {
    if (!currentEditableContext) return;
    openRowEditor("add", null);
}

function openEditRowEditor(rowIndex) {
    if (!currentEditableContext || currentEditableContext.primaryKeys.length === 0) return;
    openRowEditor("edit", currentResultRows[rowIndex]);
}

function openRowEditor(mode, row) {
    rowEditorState = {
        mode: mode,
        context: currentEditableContext,
        originalRow: row
    };

    document.getElementById("row_editor_title").textContent = mode === "add" ? "Add row" : "Edit row";
    document.getElementById("row_editor_subtitle").textContent = currentEditableContext.tableName;
    document.getElementById("row_editor_save").textContent = mode === "add" ? "Insert row" : "Save changes";

    var fields = document.getElementById("row_editor_fields");
    fields.innerHTML = "";

    currentEditableContext.columns.forEach(function (column) {
        fields.appendChild(createRowEditorField(column, mode === "edit" ? row[column.name] : "", mode));
    });

    document.getElementById("row_editor_panel").style.display = "flex";
}

function createRowEditorField(column, value, mode) {
    var wrapper = document.createElement("div");
    wrapper.className = "row-editor-field";
    wrapper.dataset.columnName = column.name;

    var label = document.createElement("div");
    label.className = "row-editor-label";
    label.textContent = column.name;

    var details = document.createElement("small");
    details.textContent = (column.type || "NO TYPE") +
        (column.primaryKeyOrder > 0 ? " · PK" : "") +
        (column.notNull ? " · NOT NULL" : "");
    label.appendChild(details);

    var input = document.createElement("input");
    input.className = "row-editor-input";
    input.dataset.role = "value";
    input.value = value === null || value === undefined ? "" : formatEditorValue(value);

    var isBlob = value && typeof value === "object" && value.byteLength !== undefined;
    if (isBlob) {
        input.value = "[BLOB " + value.byteLength + " bytes]";
        input.disabled = true;
        input.dataset.blob = "true";
    }

    var options = document.createElement("div");
    options.className = "row-editor-null";

    var nullLabel = document.createElement("label");
    var nullCheckbox = document.createElement("input");
    nullCheckbox.type = "checkbox";
    nullCheckbox.dataset.role = "null";
    nullCheckbox.checked = value === null;
    nullCheckbox.addEventListener("change", function () {
        input.disabled = nullCheckbox.checked || input.dataset.blob === "true";
    });
    nullLabel.appendChild(nullCheckbox);
    nullLabel.appendChild(document.createTextNode(" NULL"));
    options.appendChild(nullLabel);

    if (mode === "add" && (column.defaultValue !== null || /INT/i.test(column.type) && column.primaryKeyOrder > 0)) {
        var defaultLabel = document.createElement("label");
        var defaultCheckbox = document.createElement("input");
        defaultCheckbox.type = "checkbox";
        defaultCheckbox.dataset.role = "default";
        defaultCheckbox.checked = true;
        defaultCheckbox.addEventListener("change", function () {
            input.disabled = defaultCheckbox.checked || nullCheckbox.checked || input.dataset.blob === "true";
        });
        input.disabled = true;
        defaultLabel.appendChild(defaultCheckbox);
        defaultLabel.appendChild(document.createTextNode(" Default"));
        options.appendChild(defaultLabel);
    }

    wrapper.appendChild(label);
    wrapper.appendChild(input);
    wrapper.appendChild(options);
    return wrapper;
}

function formatEditorValue(value) {
    if (value instanceof Uint8Array) return "[BLOB " + value.length + " bytes]";
    return String(value);
}

function parseEditorValue(value, type) {
    var normalizedType = String(type || "").toUpperCase();

    if (value !== "" && /INT/.test(normalizedType) && /^[-+]?\d+$/.test(value)) {
        return parseInt(value, 10);
    }

    if (value !== "" && /REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(normalizedType) && !isNaN(Number(value))) {
        return Number(value);
    }

    return value;
}

function closeRowEditor() {
    document.getElementById("row_editor_panel").style.display = "none";
    rowEditorState = null;
}

function collectRowEditorValues() {
    var values = [];
    var fields = document.querySelectorAll("#row_editor_fields .row-editor-field");

    fields.forEach(function (field) {
        var columnName = field.dataset.columnName;
        var column = rowEditorState.context.columns.filter(function (item) {
            return item.name === columnName;
        })[0];
        var input = field.querySelector('[data-role="value"]');
        var nullCheckbox = field.querySelector('[data-role="null"]');
        var defaultCheckbox = field.querySelector('[data-role="default"]');
        var originalValue = rowEditorState.originalRow ? rowEditorState.originalRow[columnName] : undefined;

        values.push({
            column: column,
            useDefault: !!(defaultCheckbox && defaultCheckbox.checked),
            value: nullCheckbox && nullCheckbox.checked
                ? null
                : input.dataset.blob === "true" ? originalValue : parseEditorValue(input.value, column.type)
        });
    });

    return values;
}

function saveRowEditor() {
    if (!rowEditorState || !db) return;

    var context = rowEditorState.context;
    var editMode = rowEditorState.mode;
    var values = collectRowEditorValues();

    try {
        executeDatabaseEdit(function () {
            if (rowEditorState.mode === "add") {
                var insertValues = values.filter(function (item) { return !item.useDefault; });

                if (insertValues.length === 0) {
                    db.run("INSERT INTO " + quoteSQLiteIdentifier(context.tableName) + " DEFAULT VALUES");
                } else {
                    db.run(
                        "INSERT INTO " + quoteSQLiteIdentifier(context.tableName) + " (" +
                        insertValues.map(function (item) { return quoteSQLiteIdentifier(item.column.name); }).join(", ") +
                        ") VALUES (" + insertValues.map(function () { return "?"; }).join(", ") + ")",
                        insertValues.map(function (item) { return item.value; })
                    );
                }
            } else {
                var where = buildPrimaryKeyWhere(context, rowEditorState.originalRow);
                db.run(
                    "UPDATE " + quoteSQLiteIdentifier(context.tableName) + " SET " +
                    values.map(function (item) {
                        return quoteSQLiteIdentifier(item.column.name) + " = ?";
                    }).join(", ") + " WHERE " + where.sql,
                    values.map(function (item) { return item.value; }).concat(where.params)
                );
            }
        });

        closeRowEditor();
        markDatabaseDirty(editMode === "add" ? "Insert" : "Update");
        refreshAfterRowMutation(context.tableName);
    } catch (error) {
        showError(error);
    }
}

function buildPrimaryKeyWhere(context, row) {
    var clauses = [];
    var params = [];

    context.primaryKeys.forEach(function (column) {
        clauses.push(quoteSQLiteIdentifier(column.name) + " IS ?");
        params.push(row[column.name]);
    });

    return { sql: clauses.join(" AND "), params: params };
}

function deleteResultRow(rowIndex) {
    if (!currentEditableContext || currentEditableContext.primaryKeys.length === 0) return;

    var row = currentResultRows[rowIndex];
    if (!row || !confirm("Delete this row from " + currentEditableContext.tableName + "?")) return;

    try {
        var context = currentEditableContext;
        var where = buildPrimaryKeyWhere(context, row);

        executeDatabaseEdit(function () {
            db.run(
                "DELETE FROM " + quoteSQLiteIdentifier(context.tableName) + " WHERE " + where.sql,
                where.params
            );
        });

        markDatabaseDirty("Delete");
        refreshAfterRowMutation(context.tableName);
    } catch (error) {
        showError(error);
    }
}

function executeDatabaseEdit(callback) {
    db.run("SAVEPOINT sqlite_viewer_edit");

    try {
        callback();
        db.run("RELEASE sqlite_viewer_edit");
    } catch (error) {
        try {
            db.run("ROLLBACK TO sqlite_viewer_edit");
            db.run("RELEASE sqlite_viewer_edit");
        } catch (rollbackError) {
            console.error(rollbackError);
        }
        throw error;
    }
}

function refreshAfterRowMutation(tableName) {
    rowCounts[tableName] = null;
    tableSortCache.rows = false;
    tableSortCache.cells = false;
    tableSortCache.bytes = false;
    renderQuery(editor.getValue(), false);
}

function setQueryResultStatus(message, state) {
    var status = document.getElementById("query_result_status");
    if (!status) return;

    status.textContent = message || "";
    status.className = "query-result-status" + (state ? " is-" + state : "");
}

function buildQueryResultMessage(result, elapsed) {
    if (result.rowsModified > 0 && result.rowCount === 0) {
        return result.rowsModified + " row" + (result.rowsModified === 1 ? "" : "s") +
            " modified in " + elapsed + " ms.";
    }

    var message = result.rowCount + " row" + (result.rowCount === 1 ? "" : "s") +
        " displayed in " + elapsed + " ms.";

    if (result.truncated) {
        message += " Display capped at " + MAX_RENDERED_ROWS + " rows; add LIMIT or filters for more control.";
    }

    return message;
}

function getQueryMutationType(query) {
    var cleaned = String(query)
        .replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, "")
        .trim();
    var match = cleaned.match(/^(INSERT|UPDATE|DELETE|REPLACE|CREATE|DROP|ALTER|REINDEX|VACUUM|ANALYZE)\b/i);

    if (match) return match[1].toUpperCase();
    if (/^PRAGMA\s+[A-Za-z0-9_.]+\s*=/.test(cleaned.toUpperCase())) return "PRAGMA";
    return null;
}

function refreshDatabaseObjectList() {
    if (!db) return;

    var selectedTable = document.getElementById("tableName").value;
    var tableList = $("#tables");
    resetTableList();
    tableMetaList = [];
    rowCounts = [];
    schemaLoaded = false;
    buildSchemaSuggestions();

    var tables = db.prepare(
        "SELECT * FROM sqlite_master WHERE type='table' OR type='view' ORDER BY UPPER(name)"
    );

    processTablesAsync(tables, tableList, null, function (firstTableName) {
        renderTableList();
        $("#table_sort_bar").show();
        var nextTable = tableMetaList.some(function (table) { return table.name === selectedTable; })
            ? selectedTable
            : firstTableName;
        setSelectedTableControl(nextTable);
        document.getElementById("tableName").value = nextTable || "";
        hideDbProgress();
    });
}

function initQueryWorkspace() {
    try {
        queryTabs = JSON.parse(localStorage.getItem("sqliteViewer.queryTabs") || "[]");
        queryHistory = JSON.parse(localStorage.getItem("sqliteViewer.queryHistory") || "[]");
        activeQueryTabId = localStorage.getItem("sqliteViewer.activeQueryTab") || null;
    } catch (error) {
        queryTabs = [];
        queryHistory = [];
    }

    if (!Array.isArray(queryTabs)) queryTabs = [];

    if (!Array.isArray(queryHistory)) queryHistory = [];
    queryHistory = queryHistory.filter(function (item) {
        return item && item.success === true && item.query;
    }).slice(0, QUERY_HISTORY_LIMIT);

    if (queryTabs.length > 0 && !queryTabs.some(function (tab) { return tab.id === activeQueryTabId; })) {
        activeQueryTabId = queryTabs[0].id;
    } else if (queryTabs.length === 0) {
        activeQueryTabId = null;
    }

    renderQueryTabs();
    loadActiveQueryTab();

    editor.on("change", function () {
        if (queryWorkspaceChanging) return;

        var tab = getActiveQueryTab();
        if (!tab) return;

        tab.sql = editor.getValue();
        scheduleQueryWorkspaceSave();
    });
}

function createQueryTabId() {
    return "query_" + Date.now() + "_" + Math.random().toString(36).slice(2, 8);
}

function getActiveQueryTab() {
    return queryTabs.filter(function (tab) { return tab.id === activeQueryTabId; })[0] || null;
}

function createQueryTab(initialSql, initialTitle) {
    var number = queryTabs.length + 1;
    var tab = {
        id: createQueryTabId(),
        title: initialTitle ? String(initialTitle).slice(0, 40) : "Query " + number,
        sql: initialSql || ""
    };

    queryTabs.push(tab);
    activeQueryTabId = tab.id;
    renderQueryTabs();
    loadActiveQueryTab();
    saveQueryWorkspace();
    editor.focus();
}

function selectQueryTab(tabId) {
    if (tabId === activeQueryTabId) return;

    var currentTab = getActiveQueryTab();
    if (currentTab) currentTab.sql = editor.getValue();

    activeQueryTabId = tabId;
    renderQueryTabs();
    loadActiveQueryTab();
    saveQueryWorkspace();
}

function closeQueryTab(event, tabId) {
    if (event) event.stopPropagation();

    var index = queryTabs.findIndex(function (tab) { return tab.id === tabId; });
    if (index < 0) return;

    queryTabs.splice(index, 1);

    if (activeQueryTabId === tabId) {
        if (queryTabs.length > 0) {
            activeQueryTabId = queryTabs[Math.min(index, queryTabs.length - 1)].id;
            loadActiveQueryTab();
        } else {
            activeQueryTabId = null;
            queryWorkspaceChanging = true;
            editor.setValue("", -1);
            queryWorkspaceChanging = false;
            clearQueryResultForTab("Select a table or create a new query.");
        }
    }

    renderQueryTabs();
    saveQueryWorkspace();
}

function renameQueryTab(tabId) {
    var tab = queryTabs.filter(function (item) { return item.id === tabId; })[0];
    if (!tab) return;

    var title = prompt("Query tab name", tab.title);
    if (!title || !title.trim()) return;

    tab.title = title.trim().slice(0, 40);
    renderQueryTabs();
    saveQueryWorkspace();
}

function loadActiveQueryTab() {
    var tab = getActiveQueryTab();
    if (!tab) return;

    queryWorkspaceChanging = true;
    editor.setValue(tab.sql || "", -1);
    queryWorkspaceChanging = false;
    restoreActiveQueryTabResult(tab);
}

function restoreActiveQueryTabResult(tab) {
    if (!db || !tab) return;

    var query = getSafeTabRefreshQuery(tab.sql);
    if (!query) {
        clearQueryResultForTab(
            tab.sql && tab.sql.trim()
                ? "This tab contains a write or unsupported query. Press Execute to run it."
                : "Enter a query and press Execute."
        );
        return;
    }

    var tableName = getTableNameFromQuery(query);
    if (tableName) {
        document.getElementById("tableName").value = tableName;
        if (tableMetaList.some(function (table) { return table.name === tableName; })) {
            setSelectedTableControl(tableName);
        }
    }

    var startedAt = Date.now();
    var result = renderQuery(query, false);
    var elapsed = Date.now() - startedAt;

    if (result && result.success) {
        setQueryResultStatus(
            "Loaded result for " + tab.title + ". " + buildQueryResultMessage(result, elapsed),
            result.truncated ? "warning" : "success"
        );
    }
}

function getSafeTabRefreshQuery(query) {
    var cleaned = String(query || "")
        .replace(/^\s*(?:--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/\s*)*/g, "")
        .trim();

    if (/^SELECT\b/i.test(cleaned)) return cleaned;
    if (/^EXPLAIN\s+(?:QUERY\s+PLAN\s+)?SELECT\b/i.test(cleaned)) return cleaned;
    return null;
}

function clearQueryResultForTab(message) {
    var dataBox = $("#data");
    dataBox.find("thead tr").empty();
    dataBox.find("tbody").empty();
    dataBox.hide();
    errorBox.hide();
    $("#bottom-bar").hide();

    currentResultRows = [];
    currentEditableContext = null;
    currentColumnNames = [];
    visibleColumns = {};
    pinnedColumns = {};
    updateRowEditingControls();
    setQueryResultStatus(message || "", "");
}

function renderQueryTabs() {
    var container = document.getElementById("query_tabs");
    if (!container) return;
    container.innerHTML = "";

    queryTabs.forEach(function (tab, tabIndex) {
        var button = document.createElement("button");
        button.type = "button";
        button.className = "query-tab" + (tab.id === activeQueryTabId ? " active" : "");
        button.setAttribute("role", "tab");
        button.setAttribute("aria-selected", tab.id === activeQueryTabId ? "true" : "false");
        button.addEventListener("click", function () { selectQueryTab(tab.id); });
        button.addEventListener("dblclick", function () { renameQueryTab(tab.id); });

        var title = document.createElement("span");
        title.className = "query-tab-title";
        title.textContent = tab.title;
        button.appendChild(title);

        var closeButton = document.createElement("span");
        closeButton.className = "query-tab-close";
        closeButton.textContent = "\u00d7";
        closeButton.setAttribute("aria-label", "Close " + tab.title);
        closeButton.addEventListener("click", function (event) { closeQueryTab(event, tab.id); });
        button.appendChild(closeButton);
        enableTabReorder(button, queryTabs, tabIndex, function () {
            renderQueryTabs();
            scheduleQueryWorkspaceSave();
        });
        container.appendChild(button);
    });

    var newQueryButton = document.createElement("button");
    newQueryButton.type = "button";
    newQueryButton.className = "query-tab-new";
    newQueryButton.textContent = "+";
    newQueryButton.title = "New query";
    newQueryButton.setAttribute("aria-label", "New query");
    newQueryButton.addEventListener("click", function () { createQueryTab(""); });
    container.appendChild(newQueryButton);
}

function scheduleQueryWorkspaceSave() {
    clearTimeout(queryWorkspaceSaveTimer);
    queryWorkspaceSaveTimer = setTimeout(saveQueryWorkspace, 250);
}

function saveQueryWorkspace() {
    captureActiveDatabaseSession();

    try {
        localStorage.setItem("sqliteViewer.queryTabs", JSON.stringify(queryTabs));
        localStorage.setItem("sqliteViewer.activeQueryTab", activeQueryTabId || "");
        localStorage.setItem("sqliteViewer.queryHistory", JSON.stringify(queryHistory));
    } catch (error) {
        console.warn("Could not save query workspace", error);
    }
}

function addQueryHistory(query, success, elapsed, rowCount, rowsModified) {
    if (!success) return;

    var normalized = String(query).trim();
    if (!normalized) return;

    if (queryHistory.length > 0 && queryHistory[0].query === normalized) {
        queryHistory.shift();
    }

    queryHistory.unshift({
        query: normalized,
        success: !!success,
        elapsed: elapsed,
        rowCount: rowCount || 0,
        rowsModified: rowsModified || 0,
        timestamp: new Date().toISOString()
    });

    queryHistory = queryHistory.slice(0, QUERY_HISTORY_LIMIT);
    scheduleQueryWorkspaceSave();
}

function openQueryHistory() {
    renderQueryHistory();
    document.getElementById("query_history_panel").style.display = "flex";
}

function closeQueryHistory() {
    document.getElementById("query_history_panel").style.display = "none";
}

function clearQueryHistory() {
    if (!confirm("Clear all query history stored in this browser?")) return;
    queryHistory = [];
    saveQueryWorkspace();
    renderQueryHistory();
}

function renderQueryHistory() {
    var container = document.getElementById("query_history_list");
    container.innerHTML = "";

    if (queryHistory.length === 0) {
        var empty = document.createElement("div");
        empty.className = "query-history-item";
        empty.textContent = "No query history yet.";
        container.appendChild(empty);
        return;
    }

    queryHistory.forEach(function (item) {
        var wrapper = document.createElement("div");
        wrapper.className = "query-history-item";

        var content = document.createElement("div");
        var query = document.createElement("pre");
        query.className = "query-history-query";
        query.textContent = item.query;

        var meta = document.createElement("div");
        meta.className = "query-history-meta";
        meta.textContent = new Date(item.timestamp).toLocaleString() + " · " +
            (item.success ? "Success" : "Failed") + " · " + item.elapsed + " ms";

        content.appendChild(query);
        content.appendChild(meta);

        var loadButton = document.createElement("button");
        loadButton.type = "button";
        loadButton.className = "toolbar-btn";
        loadButton.textContent = "Load";
        loadButton.addEventListener("click", function () {
            var tab = getActiveQueryTab();
            if (tab) tab.sql = item.query;
            queryWorkspaceChanging = true;
            editor.setValue(item.query, -1);
            queryWorkspaceChanging = false;
            saveQueryWorkspace();
            closeQueryHistory();
            editor.focus();
        });

        wrapper.appendChild(content);
        wrapper.appendChild(loadButton);
        container.appendChild(wrapper);
    });
}

function openColumnPanel() {
    buildColumnVisibilityList();
    document.getElementById("column_visibility_panel").style.display = "flex";
}

function closeColumnPanel() {
    document.getElementById("column_visibility_panel").style.display = "none";
}

function buildColumnVisibilityList() {
    var box = document.getElementById("column_visibility_list");
    box.innerHTML = "";

    currentColumnNames.forEach(function (col) {
        if (visibleColumns[col] === undefined) visibleColumns[col] = true;

        box.innerHTML += `
            <label class="column-check-row">
                <input type="checkbox"
                       ${visibleColumns[col] ? "checked" : ""}
                       onchange="toggleColumnVisibility('${col}', this.checked)">
                ${col}
            </label>
        `;
    });
}

function toggleColumnVisibility(columnName, isVisible) {
    visibleColumns[columnName] = isVisible;
    applyColumnVisibility();
}

function showAllColumns() {
    currentColumnNames.forEach(function (col) {
        visibleColumns[col] = true;
    });
    buildColumnVisibilityList();
    applyColumnVisibility();
}

function hideAllColumns() {
    currentColumnNames.forEach(function (col) {
        visibleColumns[col] = false;
    });
    buildColumnVisibilityList();
    applyColumnVisibility();
}

function applyColumnVisibility() {
    var table = document.getElementById("data");
    if (!table) return;

    currentColumnNames.forEach(function (col, index) {
        var show = visibleColumns[col] !== false;
        var display = show ? "" : "none";

        var header = table.querySelector("thead tr").children[index];
        if (header) header.style.display = display;

        var rows = table.querySelectorAll("tbody tr");
        rows.forEach(function (row) {
            if (row.children[index]) {
                row.children[index].style.display = display;
            }
        });
    });
}

function filterColumnList() {
    var filter = document.getElementById("column_search_input").value.toUpperCase();
    var rows = document.querySelectorAll(".column-check-row");

    rows.forEach(function (row) {
        row.style.display = row.innerText.toUpperCase().indexOf(filter) > -1 ? "" : "none";
    });
}

function openERDiagram() {
    if (!db) {
        alert("Please load a database first.");
        return;
    }

    document.getElementById("er_diagram_modal").style.display = "flex";
    document.getElementById("er_diagram_status").innerText = "Building ER diagram...";

    setTimeout(function () {
        var elements = buildCytoscapeERElements();

        document.getElementById("er_diagram_status").innerText =
            elements.edges.length + " relationships, " + elements.nodes.length +
            " tables | PK = Primary Key, FK = Foreign Key";

        renderCytoscapeER(elements);
    }, 100);
}

function closeERDiagram() {
    document.getElementById("er_diagram_modal").style.display = "none";

    if (erCy) {
        erCy.destroy();
        erCy = null;
    }
}

function fitERDiagram() {
    if (erCy) {
        erCy.resize();
        var elements = erCy.elements();

        if (elements.length > 0) {
            erCy.fit(elements, 40);
            erCy.center();
        }
    }
}

function buildCytoscapeERElements() {
    var nodes = [];
    var edges = [];
    var addedTables = {};

    var tables = db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );

    while (tables.step()) {
        var tableName = tables.getAsObject().name;
        var escapedTableName = tableName.replace(/'/g, "''");
        var foreignKeysByColumn = {};

        addedTables[tableName] = true;

        var fkStmt = db.prepare(
            "PRAGMA foreign_key_list('" + escapedTableName + "')"
        );

        while (fkStmt.step()) {
            var fk = fkStmt.getAsObject();
            var sourceColumn = fk.from;

            if (!foreignKeysByColumn[sourceColumn]) {
                foreignKeysByColumn[sourceColumn] = [];
            }

            foreignKeysByColumn[sourceColumn].push({
                table: fk.table,
                column: fk.to
            });

            edges.push({
                data: {
                    id: tableName + "_" + fk.from + "_to_" + fk.table + "_" + fk.to,
                    source: tableName,
                    target: fk.table,
                    label: fk.from + " → " + (fk.to || "PRIMARY KEY")
                }
            });
        }

        var tableDetails = getERTableDetails(tableName, foreignKeysByColumn);

        nodes.push({
            data: {
                id: tableName,
                label: tableName,
                displayLabel: tableName + "\n------------------------------\n" + tableDetails.text,
                columns: tableDetails.text,
                nodeHeight: tableDetails.nodeHeight
            }
        });
    }

    return {
        nodes: nodes,
        edges: edges
    };
}

function getERTableDetails(tableName, foreignKeysByColumn) {
    var columns = [];
    var visualLineCount = 0;
    var fkMap = foreignKeysByColumn || getERForeignKeyMap(tableName);
    var stmt = db.prepare(
        "PRAGMA table_info('" + tableName.replace(/'/g, "''") + "')"
    );

    while (stmt.step()) {
        var col = stmt.getAsObject();
        var keyTypes = [];
        var references = fkMap[col.name] || [];

        if (col.pk > 0) {
            keyTypes.push("PK");
        }

        if (references.length > 0) {
            keyTypes.push("FK");
        }

        var keyLabel = keyTypes.length ? "[" + keyTypes.join(", ") + "] " : "    ";
        var dataType = col.type && String(col.type).trim()
            ? String(col.type).trim().toUpperCase()
            : "NO TYPE";
        var label = keyLabel + col.name + " : " + dataType;

        if (references.length > 0) {
            label += " -> " + references.map(function (reference) {
                return reference.table + "." + (reference.column || "PRIMARY KEY");
            }).join(", ");
        }

        columns.push(label);
        visualLineCount += Math.max(1, Math.ceil(label.length / 42));
    }

    if (columns.length === 0) {
        columns.push("(no columns)");
        visualLineCount = 1;
    }

    return {
        text: columns.join("\n"),
        nodeHeight: Math.max(110, 58 + visualLineCount * 18)
    };
}

function getERForeignKeyMap(tableName) {
    var foreignKeysByColumn = {};
    var stmt = db.prepare(
        "PRAGMA foreign_key_list('" + tableName.replace(/'/g, "''") + "')"
    );

    while (stmt.step()) {
        var fk = stmt.getAsObject();

        if (!foreignKeysByColumn[fk.from]) {
            foreignKeysByColumn[fk.from] = [];
        }

        foreignKeysByColumn[fk.from].push({
            table: fk.table,
            column: fk.to
        });
    }

    return foreignKeysByColumn;
}

function getERColumnSummary(tableName) {
    return getERTableDetails(tableName).text;
}

function renderCytoscapeER(elements) {
    if (erCy) {
        erCy.destroy();
    }

    erCy = cytoscape({
        container: document.getElementById("er_diagram_container"),

        elements: elements.nodes.concat(elements.edges),

        style: getERDiagramStyle(),

        layout: {
            name: "cose",
            animate: true,
            fit: true,
            padding: 40,
            nodeRepulsion: 9000,
            idealEdgeLength: 130
        },

        wheelSensitivity: 0.2
    });

    erCy.on("tap", "node", function (evt) {
        var node = evt.target;
        showERTableInfo(node.data("id"));
    });

    erCy.one("layoutstop", function () {
        fitERDiagram();
    });

    setTimeout(fitERDiagram, 0);
}

function showERTableInfo(tableName) {
    var columns = getERColumnSummary(tableName);
    document.getElementById("er_diagram_status").innerText =
        tableName + "\n" + columns + "\n\nPK = Primary Key, FK = Foreign Key";
}

function exportERSchema() {
    if (!db) {
        alert("Please load a database first.");
        return;
    }

    var formatSelect = document.getElementById("er_export_format");
    var format = formatSelect ? formatSelect.value : "sql";
    var schema = getERSchemaMetadata();
    var exportConfig;

    if (format === "dbml") {
        exportConfig = {
            label: "DBML",
            extension: "dbml",
            mimeType: "text/plain",
            content: generateDBMLSchema(schema)
        };
    } else if (format === "graphql") {
        exportConfig = {
            label: "GraphQL SDL",
            extension: "graphql",
            mimeType: "application/graphql",
            content: generateGraphQLSchema(schema)
        };
    } else if (format === "mermaid") {
        exportConfig = {
            label: "Mermaid",
            extension: "mmd",
            mimeType: "text/plain",
            content: generateMermaidSchema(schema)
        };
    } else {
        exportConfig = {
            label: "SQL DDL",
            extension: "sql",
            mimeType: "text/sql",
            content: generateSQLDDLSchema()
        };
    }

    download(
        getExportFileName("sqlite_schema", exportConfig.extension),
        exportConfig.content,
        exportConfig.mimeType
    );

    document.getElementById("er_diagram_status").innerText =
        "Exported " + exportConfig.label + " schema for " + schema.tables.length + " tables.";
}

function getERSchemaMetadata() {
    var schema = { tables: [] };
    var tableStmt = db.prepare(
        "SELECT name FROM sqlite_master " +
        "WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    );

    while (tableStmt.step()) {
        var tableName = tableStmt.getAsObject().name;
        var escapedTableName = tableName.replace(/'/g, "''");
        var table = {
            name: tableName,
            columns: [],
            foreignKeys: []
        };
        var columnStmt = db.prepare("PRAGMA table_info('" + escapedTableName + "')");

        while (columnStmt.step()) {
            var column = columnStmt.getAsObject();

            table.columns.push({
                name: column.name,
                type: column.type || "",
                notNull: Number(column.notnull) === 1,
                defaultValue: column.dflt_value,
                primaryKeyOrder: Number(column.pk) || 0
            });
        }

        var foreignKeyStmt = db.prepare("PRAGMA foreign_key_list('" + escapedTableName + "')");

        while (foreignKeyStmt.step()) {
            var foreignKey = foreignKeyStmt.getAsObject();

            table.foreignKeys.push({
                from: foreignKey.from,
                table: foreignKey.table,
                to: foreignKey.to,
                onUpdate: foreignKey.on_update,
                onDelete: foreignKey.on_delete
            });
        }

        schema.tables.push(table);
    }

    return schema;
}

function generateSQLDDLSchema() {
    var lines = [
        "-- SQLite schema DDL",
        "PRAGMA foreign_keys = ON;",
        ""
    ];
    var stmt = db.prepare(
        "SELECT type, name, sql FROM sqlite_master " +
        "WHERE type IN ('table','view','index','trigger') " +
        "AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL " +
        "ORDER BY CASE type " +
        "WHEN 'table' THEN 1 WHEN 'view' THEN 2 WHEN 'index' THEN 3 ELSE 4 END, name"
    );

    while (stmt.step()) {
        var item = stmt.getAsObject();
        var ddl = String(item.sql || "").trim().replace(/;+\s*$/, "");

        lines.push("-- " + String(item.type).toUpperCase() + ": " + item.name);
        lines.push(ddl + ";");
        lines.push("");
    }

    return lines.join("\n");
}

function quoteDBMLIdentifier(value) {
    return '"' + String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

function normalizeDBMLType(type) {
    var normalized = String(type || "text").trim();
    return normalized ? normalized.replace(/\s+/g, "_") : "text";
}

function formatDBMLDefault(value) {
    return String(value).replace(/`/g, "\\`");
}

function resolveERForeignKeyTarget(schema, foreignKey) {
    if (foreignKey.to) return foreignKey.to;

    for (var i = 0; i < schema.tables.length; i++) {
        if (schema.tables[i].name !== foreignKey.table) continue;

        var primaryKeys = schema.tables[i].columns
            .filter(function (column) { return column.primaryKeyOrder > 0; })
            .sort(function (a, b) { return a.primaryKeyOrder - b.primaryKeyOrder; });

        if (primaryKeys.length > 0) return primaryKeys[0].name;
    }

    return "id";
}

function generateDBMLSchema(schema) {
    var lines = ["// Generated from SQLite schema", ""];

    schema.tables.forEach(function (table) {
        var primaryKeys = table.columns
            .filter(function (column) { return column.primaryKeyOrder > 0; })
            .sort(function (a, b) { return a.primaryKeyOrder - b.primaryKeyOrder; });
        var hasCompositePrimaryKey = primaryKeys.length > 1;

        lines.push("Table " + quoteDBMLIdentifier(table.name) + " {");

        table.columns.forEach(function (column) {
            var settings = [];

            if (column.primaryKeyOrder > 0 && !hasCompositePrimaryKey) settings.push("pk");
            if (column.notNull || column.primaryKeyOrder > 0) settings.push("not null");
            if (column.defaultValue !== null && column.defaultValue !== undefined) {
                settings.push("default: `" + formatDBMLDefault(column.defaultValue) + "`");
            }

            lines.push(
                "  " + quoteDBMLIdentifier(column.name) + " " + normalizeDBMLType(column.type) +
                (settings.length ? " [" + settings.join(", ") + "]" : "")
            );
        });

        if (hasCompositePrimaryKey) {
            lines.push("");
            lines.push("  indexes {");
            lines.push(
                "    (" + primaryKeys.map(function (column) {
                    return quoteDBMLIdentifier(column.name);
                }).join(", ") + ") [pk]"
            );
            lines.push("  }");
        }

        lines.push("}");
        lines.push("");
    });

    schema.tables.forEach(function (table) {
        table.foreignKeys.forEach(function (foreignKey) {
            lines.push(
                "Ref: " + quoteDBMLIdentifier(table.name) + "." +
                quoteDBMLIdentifier(foreignKey.from) + " > " +
                quoteDBMLIdentifier(foreignKey.table) + "." +
                quoteDBMLIdentifier(resolveERForeignKeyTarget(schema, foreignKey))
            );
        });
    });

    return lines.join("\n").trim() + "\n";
}

function makeUniqueSchemaName(value, fallback, usedNames) {
    var name = String(value || "").replace(/[^A-Za-z0-9_]/g, "_");

    if (!name) name = fallback;
    if (!/^[A-Za-z_]/.test(name)) name = "_" + name;
    if (name.indexOf("__") === 0) name = "_" + name;

    var uniqueName = name;
    var suffix = 2;

    while (usedNames[uniqueName]) {
        uniqueName = name + "_" + suffix;
        suffix++;
    }

    usedNames[uniqueName] = true;
    return uniqueName;
}

function mapSQLiteTypeToGraphQL(type) {
    var normalized = String(type || "").toUpperCase();

    if (normalized.indexOf("BOOL") > -1) return "Boolean";
    if (normalized.indexOf("INT") > -1) return "Int";
    if (/REAL|FLOA|DOUB|NUMERIC|DECIMAL/.test(normalized)) return "Float";
    return "String";
}

function generateGraphQLSchema(schema) {
    var lines = [
        "# Generated from SQLite schema",
        "directive @sqliteTable(name: String!) on OBJECT",
        "directive @sqliteType(name: String!) on FIELD_DEFINITION",
        "directive @primaryKey(order: Int!) on FIELD_DEFINITION",
        "directive @foreignKey(table: String!, column: String!) repeatable on FIELD_DEFINITION",
        ""
    ];
    var usedTypeNames = {};
    var typeNames = {};

    schema.tables.forEach(function (table) {
        typeNames[table.name] = makeUniqueSchemaName(table.name, "SQLiteTable", usedTypeNames);
    });

    schema.tables.forEach(function (table) {
        var usedFieldNames = {};
        var foreignKeysByColumn = {};

        table.foreignKeys.forEach(function (foreignKey) {
            if (!foreignKeysByColumn[foreignKey.from]) foreignKeysByColumn[foreignKey.from] = [];
            foreignKeysByColumn[foreignKey.from].push(foreignKey);
        });

        lines.push(
            "type " + typeNames[table.name] +
            " @sqliteTable(name: " + JSON.stringify(table.name) + ") {"
        );

        table.columns.forEach(function (column) {
            var fieldName = makeUniqueSchemaName(column.name, "field", usedFieldNames);
            var fieldType = mapSQLiteTypeToGraphQL(column.type);
            var directives = [
                "@sqliteType(name: " + JSON.stringify(column.type || "NO TYPE") + ")"
            ];

            if (column.primaryKeyOrder > 0) {
                directives.push("@primaryKey(order: " + column.primaryKeyOrder + ")");
            }

            (foreignKeysByColumn[column.name] || []).forEach(function (foreignKey) {
                directives.push(
                    "@foreignKey(table: " + JSON.stringify(foreignKey.table) +
                    ", column: " + JSON.stringify(resolveERForeignKeyTarget(schema, foreignKey)) + ")"
                );
            });

            lines.push(
                "  " + fieldName + ": " + fieldType +
                (column.notNull || column.primaryKeyOrder > 0 ? "!" : "") +
                " " + directives.join(" ")
            );
        });

        lines.push("}");
        lines.push("");
    });

    return lines.join("\n").trim() + "\n";
}

function makeMermaidIdentifier(value, fallback, usedNames) {
    return makeUniqueSchemaName(value, fallback, usedNames);
}

function makeMermaidType(type) {
    var normalized = String(type || "TEXT").trim().replace(/[^A-Za-z0-9_]/g, "_");
    if (!normalized) return "TEXT";
    return /^[A-Za-z_]/.test(normalized) ? normalized : "TYPE_" + normalized;
}

function escapeMermaidLabel(value) {
    return String(value).replace(/"/g, "'").replace(/[\r\n]+/g, " ");
}

function generateMermaidSchema(schema) {
    var lines = ["erDiagram"];
    var usedEntityNames = {};
    var entityNames = {};

    schema.tables.forEach(function (table) {
        entityNames[table.name] = makeMermaidIdentifier(table.name, "TABLE", usedEntityNames);
    });

    schema.tables.forEach(function (table) {
        var usedColumnNames = {};
        var foreignKeyColumns = {};

        table.foreignKeys.forEach(function (foreignKey) {
            foreignKeyColumns[foreignKey.from] = true;
        });

        lines.push("  %% SQLite table: " + escapeMermaidLabel(table.name));
        lines.push("  " + entityNames[table.name] + " {");

        table.columns.forEach(function (column) {
            var columnName = makeMermaidIdentifier(column.name, "column", usedColumnNames);
            var keys = [];

            if (column.primaryKeyOrder > 0) keys.push("PK");
            if (foreignKeyColumns[column.name]) keys.push("FK");

            lines.push(
                "    " + makeMermaidType(column.type) + " " + columnName +
                (keys.length ? " " + keys.join(", ") : "")
            );
        });

        lines.push("  }");
    });

    schema.tables.forEach(function (table) {
        table.foreignKeys.forEach(function (foreignKey) {
            if (!entityNames[foreignKey.table]) return;

            var sourceColumn = table.columns.filter(function (column) {
                return column.name === foreignKey.from;
            })[0];
            var parentCardinality = sourceColumn && sourceColumn.notNull ? "||" : "o|";
            var targetColumn = resolveERForeignKeyTarget(schema, foreignKey);

            lines.push(
                "  " + entityNames[table.name] + " }o--" + parentCardinality + " " +
                entityNames[foreignKey.table] + " : \"" +
                escapeMermaidLabel(foreignKey.from + " references " + targetColumn) + "\""
            );
        });
    });

    return lines.join("\n") + "\n";
}

var erDiagramResizeTimer = null;

window.addEventListener("resize", function () {
    if (!erCy) return;

    clearTimeout(erDiagramResizeTimer);
    erDiagramResizeTimer = setTimeout(function () {
        fitERDiagram();
    }, 100);
});

function toggleMobileSidebar(forceOpen) {
    var sidebar = document.getElementById("database-sidebar");
    var backdrop = document.getElementById("mobile-sidebar-backdrop");
    var toggle = document.getElementById("mobile-sidebar-toggle");

    if (!sidebar || !backdrop || !toggle) return;

    var shouldOpen = typeof forceOpen === "boolean"
        ? forceOpen
        : !sidebar.classList.contains("is-open");

    sidebar.classList.toggle("is-open", shouldOpen);
    backdrop.classList.toggle("is-visible", shouldOpen);
    toggle.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
    document.body.classList.toggle("mobile-sidebar-open", shouldOpen);
}

function closeMobileSidebar() {
    toggleMobileSidebar(false);
}

window.addEventListener("keydown", function (event) {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && db) {
        event.preventDefault();
        saveDatabaseFile();
        return;
    }

    if (event.key === "Escape") {
        closeRowEditor();
        closeQueryHistory();
        closeMobileSidebar();
    }
});

window.addEventListener("resize", function () {
    if (window.innerWidth >= 768) {
        closeMobileSidebar();
    }
});

function getERDiagramStyle() {
    var dark = document.documentElement.dataset.theme === "dark";
    var nodeBg = dark ? "#172033" : "#ffffff";
    var nodeText = dark ? "#e7edf7" : "#1f2937";
    var nodeBorder = dark ? "#60a5fa" : "#0079FF";
    var edgeLine = dark ? "#64748b" : "#9ca3af";
    var edgeText = dark ? "#cbd5e1" : "#555";
    var edgeLabelBg = dark ? "#0b1120" : "#ffffff";

    return [
        {
            selector: "node",
            style: {
                "shape": "round-rectangle",
                "background-color": nodeBg,
                "border-width": 2,
                "border-color": nodeBorder,
                "label": "data(displayLabel)",
                "text-valign": "center",
                "text-halign": "center",
                "text-justification": "left",
                "font-family": "Consolas, Monaco, monospace",
                "font-size": 11,
                "font-weight": "600",
                "color": nodeText,
                "width": 300,
                "height": "data(nodeHeight)",
                "padding": "12px",
                "text-wrap": "wrap",
                "text-max-width": 276,
                "line-height": 1.45
            }
        },
        {
            selector: "node:selected",
            style: {
                "border-color": "#ff9800",
                "border-width": 4
            }
        },
        {
            selector: "edge",
            style: {
                "width": 2,
                "line-color": edgeLine,
                "target-arrow-color": edgeLine,
                "target-arrow-shape": "triangle",
                "curve-style": "bezier",
                "label": "data(label)",
                "font-size": 10,
                "color": edgeText,
                "text-background-color": edgeLabelBg,
                "text-background-opacity": 1,
                "text-background-padding": 3
            }
        }
    ];
}
