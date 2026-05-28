var SQL_FROM_REGEX = /FROM\s+([^\s;]+)/mi;
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
            loadDB(e.target.result);
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
    var cleft = container.offset().left + container.outerWidth();
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
autocompleteBox.style.background = "#fff";
autocompleteBox.style.border = "1px solid #ccc";
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
        div.style.background = index === selectedSuggestionIndex ? "#e8f0fe" : "#fff";
        div.innerHTML = "<b>" + item.text + "</b> <span style='color:#999'>(" + item.type + ")</span>";

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

function refreshSuggestionSelection() {
    var items = autocompleteBox.querySelectorAll(".autocomplete-item");

    items.forEach(function (item, index) {
        item.style.background = index === selectedSuggestionIndex ? "#e8f0fe" : "#fff";
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

$(".no-propagate").on("click", function (el) { el.stopPropagation(); });

//Check url to load remote DB
var loadUrlDB = $.urlParam('url');
if (loadUrlDB != null) {
    var xhr = new XMLHttpRequest();
    xhr.open('GET', decodeURIComponent(loadUrlDB), true);
    xhr.responseType = 'arraybuffer';

    xhr.onload = function (e) {
        loadDB(this.response);
    };
    xhr.onerror = function (e) {
    };
    xhr.send();
}



function loadDB(arrayBuffer) {
    showDbProgress("Reading file...", 5);

    setTimeout(function () {
        loadDBInternal(arrayBuffer);
    }, 100);
}

function loadDBInternal(arrayBuffer) {

    resetTableList();

    currentTableSort = "name";

    tableSortCache = {
        rows: false,
        cells: false,
        bytes: false
    };

    tableMetaList = [];
    rowCounts = [];

    initSqlJs().then(function (SQL) {

        var tables;

        try {

            showDbProgress("Opening database...", 15);

            db = new SQL.Database(new Uint8Array(arrayBuffer));

            showDbProgress("Building schema...", 25);

            buildSchemaSuggestions();

            tables = db.prepare(
                "SELECT * FROM sqlite_master WHERE type='table' OR type='view' ORDER BY UPPER(name)"
            );

        } catch (ex) {

            hideDbProgress();

            alert(ex);
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

                tableList.select2("val", firstTableName);

                doDefaultSelect(firstTableName);

                $("#output-box").fadeIn();

                $(".nouploadinfo").hide();

                $("#sample-db-link").hide();

                $("#dropzone")
                    .delay(50)
                    .animate({
                        height: 50
                    }, 500);

                $("#success-box").show();

                $("#table_list_wrapper").show();

                $("#myInput").show();


                document
                    .getElementById("myInput")
                    .addEventListener("keyup", myFunction);

                document.getElementById("myInput").value = "";

                showDbProgress("Done", 100);

                setTimeout(function () {
                    hideDbProgress();
                }, 300);
            }
        );

    }).catch(function (err) {


        hideDbProgress();

        console.error(err);

        alert(err);
    });
}

function processTablesAsync(tables, tableList, firstTableName, done) {
    var totalTables = 0;

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

        totalTables++;
    }

    showDbProgress("Loaded " + totalTables + " tables", 80);
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
    return `
    <div class="tableNameRow" onclick="selectTable('${table.name}')">
        <div class="table-card-title">${table.name}</div>
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
        var sel = db.prepare("SELECT * FROM '" + name.replace(/'/g, "''") + "'");
        while (sel.step()) {
            var row = sel.get();
            row.forEach(function (v) {
                if (v !== null && v !== undefined) {
                    total += String(v).length;
                }
            });
        }
        return total;
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
    doDefaultSelect(name);
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
    tables.empty();
    tables.append("<option></option>");
    tables.select2({
        placeholder: "Select a table",
        formatSelection: selectFormatter,
        formatResult: selectFormatter
    });
    tables.on("change", function (e) {
        doDefaultSelect(e.val);
        //uuuuuuu
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
    $("#dropzone-dialog").click();
}

function doDefaultSelect(name) {
    document.getElementById("tableName").value = name;
    var defaultSelect = "SELECT * FROM '" + name + "' LIMIT 0,30";
    editor.setValue(defaultSelect, -1);
    renderQuery(defaultSelect, true);
}

function executeSql() {
    var query = editor.getValue();
    renderQuery(query, false);
    $("#tables").select2("val", getTableNameFromQuery(query));
}

function getTableNameFromQuery(query) {
    var sqlRegex = SQL_FROM_REGEX.exec(query);
    if (sqlRegex != null) {
        return sqlRegex[1].replace(/"|'/gi, "");
    } else {
        return null;
    }
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

function refreshPagination(query, tableName) {
    var limit = parseLimitFromQuery(query, tableName);
    if (limit !== null && limit.pages > 0) {

        var pager = $("#pager");
        pager.attr("title", "Row count: " + limit.rowCount);
        pager.tooltip('fixTitle');
        pager.text(limit.currentPage + " / " + limit.pages);

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
    console.log('_renderQuery_ ' + query)
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
        return;
    }

    var addedColums = false;
    var orderByColumn = document.getElementById("orderByColumn").value;
    console.log('_asasasas_ -' + orderByColumn);
    while (sel.step()) {
        if (!addedColums) {
            addedColums = true;
            visibleColumns = {};
            currentColumnNames = [];
            pinnedColumns = {};
            var columnNames = sel.getColumnNames();

            currentColumnNames = columnNames;

            columnNames.forEach(function (col) {
                if (visibleColumns[col] === undefined) {
                    visibleColumns[col] = true;
                }
            });

            if (columnNames.length > 0) {
                if (isDefualtOrder) {
                    orderByColumn = columnNames[0];
                }
            }
            for (var i = 0; i < columnNames.length; i++) {
                var type = columnTypes[columnNames[i]];
                var indicater = "";
                if (orderByColumn == columnNames[i] && !isDefualtOrder) {
                    if (orderByName == "ASC") {
                        indicater = "˄"
                    } else {
                        indicater = "˅"
                    }
                }
                thead.append(createTableHeader(columnNames[i], type, indicater));

            }
        }

        var tr = $('<tr>');
        var s = sel.get();
        for (var i = 0; i < s.length; i++) {
            // tr.append('<td><span title="' + htmlEncode(s[i]) + '">' + htmlEncode(s[i]) + '</span></td>');
            console.log('__SSSSSSS___ ' + s[i]);
            tr.append(createTableCell(htmlEncode(s[i]), s[i], columnNames[i]));

        }
        tbody.append(tr);
    }

    refreshPagination(query, tableName);

    $('[data-toggle="tooltip"]').tooltip({ html: true });
    dataBox.editableTableWidget();

    setTimeout(function () {
        positionFooter();
    }, 100);

    applyColumnVisibility();
    applyPinnedColumns();
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

    const content = `
    <th style="white-space:nowrap;" data-column-name="${name}">
        <div class="table-header-toolbar">
            <span data-toggle="tooltip" data-placement="top" title="${type}">${name}</span>

            <div class="table-header-actions">
                <button onclick="orderBy('${name}','${type}')"
                        class="${sortClass}"
                        title="Sort by ${name}">
                    ${sortIcon}
                </button>

                <button onclick="togglePinColumn('${name}')"
                        class="${pinClass}"
                        title="Pin / Unpin column">
                    📌
                </button>
            </div>
        </div>

        <input type="hidden" value="${name}">
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
    var tableName = document.getElementById("tableName").value
    console.log("_orderBy_ " + name);
    document.getElementById("orderByColumn").value = name;

    if (orderByName == "ASC") {
        orderByName = "DESC";
    } else {
        orderByName = "ASC";
    }
    if (type == "INTEGER") {
        editor.setValue("SELECT * FROM " + tableName + " ORDER BY CAST(" + name + " AS INTEGER) " + orderByName + " LIMIT 100");
    } else if (type == "FLOAT") {
        editor.setValue("SELECT * FROM " + tableName + " ORDER BY CAST(" + name + " AS FLOAT) " + orderByName + " LIMIT 100");
    } else if (type == "DOUBLE") {
        editor.setValue("SELECT * FROM " + tableName + " ORDER BY CAST(" + name + " AS DOUBLE) " + orderByName + " LIMIT 100");
    } else {
        editor.setValue("SELECT * FROM " + tableName + " ORDER BY UPPER(" + name + ") " + orderByName + " LIMIT 100");
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
                try {
                    if (!db) db = new SQL.Database();
                    db.run(sqlStatements);

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
                        letters += createCustomCard(name, rowCount);
                    }
                    document.getElementById('table_list_wrapper').innerHTML = letters;
                    tableList.select2("val", firstTableName);
                    doDefaultSelect(firstTableName);

                    $("#output-box").fadeIn();
                    $(".nouploadinfo").hide();
                    $("#sample-db-link").hide();
                    $("#dropzone").delay(50).animate({ height: 50 }, 500);
                    $("#table_list_wrapper").show();
                    $("#myInput").show();
                    document.getElementById("myInput").addEventListener("keyup", myFunction);
                    document.getElementById("myInput").value = "";
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

function openNav() {
    document.getElementById("myNav").style.width = "100%";
}

function closeNav() {
    document.getElementById("myNav").style.width = "0%";
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