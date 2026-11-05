/*
 * SQLite Viewer – lightweight i18n engine.
 *
 *  - English lives in the HTML (good for SEO) and in the EN dictionary below.
 *  - Other languages are separate files (js/i18n/<code>.js) loaded on demand,
 *    each calling I18N.register("<code>", { key: "text", ... }).
 *  - Static markup uses data-i18n, data-i18n-title, data-i18n-placeholder and
 *    data-i18n-aria; scripts use window.t("key", { vars }).
 *  - Plural strings are objects: { one: "...", other: "..." } and use {n}.
 *
 * To add a language: add it to LANGS, create js/i18n/<code>.js.
 * Missing keys fall back to English automatically.
 */
(function () {
    "use strict";

    var STORAGE_KEY = "sqlite-viewer-lang";
    var VERSION = "3";

    // Ordered roughly by global internet usage / reach.
    var LANGS = [
        { code: "en", name: "English" },
        { code: "zh", name: "中文（简体）" },
        { code: "zh-TW", name: "中文（繁體）" },
        { code: "es", name: "Español" },
        { code: "hi", name: "हिन्दी" },
        { code: "ar", name: "العربية", dir: "rtl" },
        { code: "pt", name: "Português" },
        { code: "id", name: "Bahasa Indonesia" },
        { code: "fr", name: "Français" },
        { code: "ru", name: "Русский" },
        { code: "ja", name: "日本語" },
        { code: "de", name: "Deutsch" },
        { code: "ko", name: "한국어" }
    ];

    var EN = {
        "page.title": "SQLite Viewer & Editor Online — Private Browser Tool",
        "page.desc": "Open, query, edit and export SQLite databases directly in your browser. Generate ER diagrams and save modified database files without uploading your data.",

        "lang.label": "Language",
        "tables": "Tables",
        "theme.label": "Color theme",
        "theme.system": "System", "theme.light": "Light", "theme.dark": "Dark",
        "theme.systemTip": "Use device theme", "theme.lightTip": "Use light theme", "theme.darkTip": "Use dark theme",

        "sort.rows": "Rows", "sort.cells": "Cells", "sort.size": "Size",
        "sort.nameTip": "Sort by table name", "sort.rowsTip": "Sort by row count",
        "sort.cellsTip": "Sort by cell count", "sort.sizeTip": "Sort by size",
        "search.tables": "Search tables",
        "card.rows": { one: "{n} row", other: "{n} rows" },
        "card.cols": { one: "{n} col", other: "{n} cols" },
        "list.count": { one: "{n} table", other: "{n} tables" },
        "sort.preparing": "Preparing {type} sort...",

        "drop.aria": "Open SQLite database",
        "drop.title": "SQLite Viewer and Editor Online",
        "drop.text": "Drop one or more database files here, or click to browse.",
        "drop.private": "Your files stay in this browser and are never uploaded.",
        "drop.sample": "Try the sample database",
        "drop.add": "Open or add database",

        "live.aria": "Live debug an Android app",
        "live.title": "Live debug your Android app",
        "live.new": "NEW",
        "live.desc": "Watch your debug app's database update in real time over USB. Works alongside Android Studio.",
        "live.auto": "Auto-refresh",
        "live.writes": "Includes recent writes",
        "live.private": "Read-only & private",
        "live.cta": "Start live debugging →",

        "bar.save": "Save DB",
        "bar.saveTip": "Download the edited database",
        "bar.er": "ER diagram",
        "bar.databases": "Databases",
        "bar.databasesAria": "Open databases",
        "bar.history": "Query history",
        "bar.queryTabs": "SQL query tabs",

        "status.none": "No database loaded",
        "status.dbsOpen": { one: "{n} database open", other: "{n} databases open" },
        "status.modified": "modified",
        "status.ready": "ready",

        "q.execute": "Execute",
        "q.columns": "Columns", "q.columnsTip": "Show / Hide Columns",
        "q.info": "Info", "q.infoTip": "Table info",
        "q.export": "Export", "q.exportTip": "Export results",
        "q.addRow": "Add row",
        "q.actions": "Query actions",

        "res.title": "Results",
        "res.aria": "Query results",
        "res.density": "Density",
        "res.compact": "Compact",
        "res.comfortable": "Comfortable",
        "res.perPage": "Rows per page",
        "res.prev": "Previous page",
        "res.next": "Next page",
        "res.range": "Rows {a}–{b} of {n}",
        "res.modified": { one: "{n} row modified in {ms} ms.", other: "{n} rows modified in {ms} ms." },
        "res.displayed": { one: "{n} row displayed in {ms} ms.", other: "{n} rows displayed in {ms} ms." },
        "res.capped": "Display capped at {n} rows; add LIMIT or filters for more control.",

        "modal.er": "ER Diagram",
        "modal.export": "Export",
        "modal.fit": "Fit",
        "modal.close": "Close",
        "export.to": "Export To",

        "cols.title": "Show / Hide Columns",
        "cols.search": "Search columns...",
        "cols.showAll": "Show All",
        "cols.hideAll": "Hide All",

        "row.add": "Add row",
        "row.edit": "Edit row",
        "row.insert": "Insert row",
        "row.saveChanges": "Save changes",
        "row.cancel": "Cancel",

        "hist.title": "Query history",
        "hist.sub": "Stored only in this browser.",
        "hist.clear": "Clear history",

        "android.title": "Android device (ADB)",
        "android.sub": "View a debug app's database over USB. Nothing is uploaded.",

        "toast.copied": "Copied: {v}",
        "toast.copyFailed": "Copy failed",
        "alert.loadFirst": "Please load a database first.",
        "confirm.close": "Close {name} without downloading the latest changes?",
        "confirm.deleteRow": "Delete this row from {table}?",
        "confirm.clearHistory": "Clear all query history stored in this browser?",

        "seo.eyebrow": "Private browser-based database workspace",
        "seo.h2": "Inspect and edit SQLite files without uploading your data",
        "seo.lead": "SQLite Viewer runs directly in your browser. Open a local <code>.db</code>, <code>.sqlite</code>, <code>.sqlite3</code> or <code>.db3</code> file, explore its schema and rows, run SQL, make changes and download the latest database—all without sending the file to a server.",
        "seo.featuresAria": "SQLite Viewer features",
        "seo.how": "How it works",
        "seo.howH2": "From database file to useful answer in three steps",
        "seo.s1t": "Open a database.",
        "seo.s1d": "Drop a supported SQLite file onto the page or use the file picker.",
        "seo.s2t": "Explore or query it.",
        "seo.s2d": "Select a table, inspect columns, edit rows or execute your own SQL.",
        "seo.s3t": "Export what you need.",
        "seo.s3d": "Download results, schema definitions or the complete modified database.",
        "seo.guides": "Practical SQLite guides",
        "seo.guidesH2": "Learn the workflow or open a specialized tool",
        "seo.faq": "Common questions",
        "seo.faqH2": "SQLite Viewer FAQ",
        "seo.q1": "Is my SQLite database uploaded?",
        "seo.a1": "No. The database is opened and processed locally by JavaScript in your browser. The tool does not need to upload the file to inspect it.",
        "seo.q2": "Can I edit and save a SQLite database?",
        "seo.a2": "Yes. You can edit supported table rows or execute write queries, then use Save DB to download the latest database state.",
        "seo.q3": "Which SQLite file extensions are supported?",
        "seo.a3": "The file picker accepts <code>.db</code>, <code>.sqlite</code>, <code>.sqlite3</code> and <code>.db3</code>. A valid SQLite database may use another extension, but it may need to be renamed before selection.",
        "seo.l1t": "How to open a SQLite file online",
        "seo.l1d": "A safe step-by-step browser workflow.",
        "seo.l2t": "SQLite editor online",
        "seo.l2d": "Edit rows and save a modified database.",
        "seo.l3t": "SQLite ER diagram generator",
        "seo.l3d": "Understand tables, keys and relationships.",
        "seo.l4t": "SQLite to CSV",
        "seo.l4d": "Export any table or query result as CSV.",
        "seo.l5t": "SQLite to JSON",
        "seo.l5d": "Get rows as a JSON array of objects.",
        "seo.l6t": "SQLite to Excel",
        "seo.l6d": "Create an XLSX workbook from your data.",
        "seo.l7t": "SQLite to SQL DDL",
        "seo.l7d": "Export portable schema definitions.",
        "seo.l8t": "SQLite to DBML",
        "seo.l8d": "Move a schema into database design tools.",
        "seo.l9t": "SQLite to Mermaid",
        "seo.l9d": "Create a text-based ER diagram.",
        "seo.l10t": "SQLite to GraphQL SDL",
        "seo.l10d": "Generate a useful GraphQL schema starting point.",
        "seo.l11t": "View an Android SQLite database",
        "seo.l11d": "Inspect an exported app database safely.",
        "seo.l12t": "SQLite browser without installation",
        "seo.l12d": "Know when a local browser tool is the right choice.",
        "seo.l13t": "Live edit an Android app database",
        "seo.l13d": "Change rows in your running debug app from the browser.",
        "seo.l14t": "Useful SQLite queries",
        "seo.l14d": "Inspect tables, keys, duplicates and query plans.",
        "seo.q4": "Does it work with large databases?",
        "seo.a4": "Large files depend on available browser memory. The viewer limits rendered result rows and samples expensive table metadata to remain responsive.",
        "seo.f1t": "Browse and search tables",
        "seo.f1d": "Navigate large schemas, sort the table list by name, rows, cells or estimated size, and pin important result columns.",
        "seo.f2t": "Edit real database rows",
        "seo.f2d": "Add, update and delete rows with primary-key-aware controls. Write changes stay in the in-browser database until you download it.",
        "seo.f3t": "Use a multi-tab SQL workspace",
        "seo.f3d": "Open a fresh tab for each table or query, switch between multiple databases and keep each result connected to its query.",
        "seo.f4t": "Generate an ER diagram",
        "seo.f4d": "Visualize entities, columns, data types, primary keys and foreign-key relationships, then fit the diagram to the window.",
        "seo.f5t": "Export schema and results",
        "seo.f5d": "Export ER schemas as SQL DDL, DBML, Mermaid or GraphQL SDL, and export query results in common data formats.",
        "seo.f6t": "Save the modified SQLite file",
        "seo.f6d": "Changes are applied locally. Choose Save DB whenever you want to download the current database as a usable SQLite file."
    };

    var dicts = { en: EN };
    var current = "en";
    var scriptBase = (function () {
        var s = document.currentScript;
        if (s && s.src) return s.src.replace(/[^\/]*(\?.*)?$/, "");
        return "js/";
    }());

    function langInfo(code) {
        for (var i = 0; i < LANGS.length; i++) if (LANGS[i].code.toLowerCase() === String(code).toLowerCase()) return LANGS[i];
        return null;
    }

    function pluralForm(value, n) {
        if (typeof value !== "object" || value === null) return value;
        var cat = "other";
        try { cat = new Intl.PluralRules(current).select(n); } catch (e) { }
        return value[cat] !== undefined ? value[cat] : (value.other !== undefined ? value.other : value.one);
    }

    function t(key, vars) {
        var value = dicts[current] && dicts[current][key];
        if (value === undefined) value = EN[key];
        if (value === undefined) return key;
        value = pluralForm(value, vars && vars.n !== undefined ? Number(vars.n) : 1);
        if (typeof value !== "string") return key;
        if (!vars) return value;
        return value.replace(/\{(\w+)\}/g, function (m, name) {
            return vars[name] !== undefined ? vars[name] : m;
        });
    }

    function each(selector, fn) {
        var nodes = document.querySelectorAll(selector);
        for (var i = 0; i < nodes.length; i++) fn(nodes[i]);
    }

    // ---- Article / tutorial pages (<html data-i18n-page="slug">) ----
    var PAGE_SLUG = document.documentElement.getAttribute("data-i18n-page");
    var commonDicts = {};
    var pageDicts = null;      // { lang: [strings...] }
    var pageOriginals = null;  // English snapshot, taken once
    var pageEls = null;
    var PAGE_SELECTOR = "h1,h2,h3,h4,p,li,summary,dt,dd,td,th,figcaption,.guide-callout,.guide-nav-links a,.guide-related a,a.guide-cta,.guide-footer";

    // Ordered list of translatable blocks (shared with the build-time extractor).
    function collectPageTargets(doc) {
        var body = (doc || document).body;
        var all = body.querySelectorAll(PAGE_SELECTOR), out = [];
        for (var i = 0; i < all.length; i++) {
            var el = all[i];
            if (el.closest("pre")) continue;
            if (el.querySelector(PAGE_SELECTOR)) continue;      // only leaf blocks
            if (!/[A-Za-z]/.test(el.textContent)) continue;
            out.push(el);
        }
        return out;
    }

    function applyPage() {
        if (!pageEls) pageEls = collectPageTargets();
        var meta = document.querySelector('meta[name="description"]');
        if (!pageOriginals) {
            pageOriginals = [document.title, meta ? meta.getAttribute("content") : ""];
            pageEls.forEach(function (el) { pageOriginals.push(el.innerHTML); });
        }
        var list = current === "en" ? pageOriginals : (pageDicts && pageDicts[current]);
        if (!list || list.length !== pageOriginals.length) {
            if (list && window.console) console.warn("i18n page: expected " + pageOriginals.length + " strings, got " + list.length);
            list = pageOriginals;
        }
        // 0 = shared string: look it up in the common table by its English original.
        if (list !== pageOriginals) list = list.map(function (v, i) {
            if (v !== 0) return v;
            var orig = pageOriginals[i], key = /^© 2026/.test(orig) ? "@footer" : orig;
            return (commonDicts[current] && commonDicts[current][key]) || orig;
        });
        var brand = document.querySelector(".guide-brand");
        var root = brand ? brand.getAttribute("href") : "../";
        if (list !== pageOriginals) list = list.map(function (x) { return x.split("{root}").join(root); });
        document.title = list[0];
        if (meta) meta.setAttribute("content", list[1]);
        pageEls.forEach(function (el, i) { el.innerHTML = list[i + 2]; });
    }

    function applyDom() {
        each("[data-i18n]", function (el) { el.textContent = t(el.getAttribute("data-i18n")); });
        each("[data-i18n-html]", function (el) { el.innerHTML = t(el.getAttribute("data-i18n-html")); });
        each("[data-i18n-title]", function (el) { el.setAttribute("title", t(el.getAttribute("data-i18n-title"))); });
        each("[data-i18n-placeholder]", function (el) { el.setAttribute("placeholder", t(el.getAttribute("data-i18n-placeholder"))); });
        each("[data-i18n-aria]", function (el) { el.setAttribute("aria-label", t(el.getAttribute("data-i18n-aria"))); });

        if (PAGE_SLUG) {
            applyPage();
        } else {
            document.title = t("page.title");
            var meta = document.querySelector('meta[name="description"]');
            if (meta) meta.setAttribute("content", t("page.desc"));
        }

        var info = langInfo(current) || {};
        document.documentElement.setAttribute("lang", current);
        document.documentElement.setAttribute("dir", info.dir || "ltr");

        var select = document.getElementById("lang_select");
        if (select) {
            select.value = current;
            select.setAttribute("aria-label", t("lang.label"));
        }
        var label = document.getElementById("lang_label");
        if (label) label.textContent = t("lang.label");
    }

    function loadScript(name, done) {
        var el = document.createElement("script");
        el.src = scriptBase + "i18n/" + name + ".js?v=" + VERSION;
        el.async = true;
        el.onload = function () { done(true); };
        el.onerror = function () { done(false); };
        document.head.appendChild(el);
    }

    function loadDict(code, done) {
        if (dicts[code]) { done(true); return; }
        loadScript(code, function (ok) {
            if (!ok) { done(false); return; }
            // Long-form page text lives in a companion file; optional.
            loadScript(code + "-seo", function () { done(true); });
        });
    }

    function setLang(code, persist) {
        if (!langInfo(code)) code = "en";
        loadDict(code, function (ok) {
            current = ok ? code : "en";
            if (PAGE_SLUG && current !== "en" && !pageDicts) {
                loadScript("pages/_common", function () {
                    loadScript("pages/" + PAGE_SLUG, function () { finish(); });
                });
                return;
            }
            finish();
        });
        function finish() {
            if (persist !== false) {
                try { localStorage.setItem(STORAGE_KEY, current); } catch (e) { }
            }
            applyDom();
            try {
                document.dispatchEvent(new CustomEvent("i18n:change", { detail: { lang: current } }));
            } catch (e) { }
        }
    }

    function detect() {
        var fromUrl = null;
        try { fromUrl = new URLSearchParams(location.search).get("lang"); } catch (e) { }
        if (fromUrl && langInfo(fromUrl)) return { code: langInfo(fromUrl).code, persist: true };

        try {
            var saved = localStorage.getItem(STORAGE_KEY);
            if (saved && langInfo(saved)) return { code: langInfo(saved).code, persist: false };
        } catch (e) { }

        var prefs = (navigator.languages && navigator.languages.length) ? navigator.languages : [navigator.language || "en"];
        for (var i = 0; i < prefs.length; i++) {
            var tag = String(prefs[i]).toLowerCase();
            // Traditional Chinese: Taiwan, Hong Kong, Macau or an explicit Hant script.
            if (/^zh-(tw|hk|mo|hant)/.test(tag)) return { code: "zh-TW", persist: false };
            var base = tag.split("-")[0];
            if (langInfo(base)) return { code: langInfo(base).code, persist: false };
        }
        return { code: "en", persist: false };
    }

    function buildSwitcher() {
        var host = document.getElementById("lang-switch");
        if (!host || document.getElementById("lang_select")) return;

        var globe = document.createElement("span");
        globe.className = "lang-globe";
        globe.setAttribute("aria-hidden", "true");
        globe.innerHTML = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.6 2.7 4 5.7 4 9s-1.4 6.3-4 9c-2.6-2.7-4-5.7-4-9s1.4-6.3 4-9z"/></svg>';

        var select = document.createElement("select");
        select.id = "lang_select";
        select.className = "lang-select";
        select.setAttribute("aria-label", t("lang.label"));
        select.title = t("lang.label");
        LANGS.forEach(function (l) {
            var opt = document.createElement("option");
            opt.value = l.code;
            opt.textContent = l.name;
            opt.lang = l.code;
            select.appendChild(opt);
        });
        select.value = current;
        select.addEventListener("change", function () { setLang(select.value, true); });

        host.appendChild(globe);
        host.appendChild(select);
    }

    window.I18N = {
        LANGS: LANGS,
        t: t,
        setLang: setLang,
        getLang: function () { return current; },
        registerCommon: function (d) { commonDicts = d; },
        registerPage: function (slug, dicts_) { if (slug === PAGE_SLUG) pageDicts = dicts_; },
        collectPageTargets: collectPageTargets,
        register: function (code, dict) { dicts[code] = Object.assign(dicts[code] || {}, dict); }
    };
    window.t = t;

    function init() {
        buildSwitcher();
        var choice = detect();
        if (choice.code === "en") {
            // English markup is already in the page; just sync dir/lang + switcher.
            current = "en";
            applyDom();
            if (choice.persist) { try { localStorage.setItem(STORAGE_KEY, "en"); } catch (e) { } }
        } else {
            setLang(choice.code, choice.persist);
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
}());
