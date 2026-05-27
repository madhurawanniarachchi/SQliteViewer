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
$.urlParam = function(name){
    var results = new RegExp('[\?&]' + name + '=([^&#]*)').exec(window.location.href);
    if (results==null){
        return null;
    }
    else{
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
    var footerTop = ($(window).scrollTop()+$(window).height());

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
document.getElementById("excel-import-dialog").addEventListener("change", function(){
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
    setIsLoading(true);
    var xhr = new XMLHttpRequest();
    xhr.open('GET', decodeURIComponent(loadUrlDB), true);
    xhr.responseType = 'arraybuffer';

    xhr.onload = function(e) {
        loadDB(this.response);
    };
    xhr.onerror = function (e) {
        setIsLoading(false);
    };
    xhr.send();
}

function loadDB(arrayBuffer) {
    setIsLoading(true);

    resetTableList();

    initSqlJs().then(function(SQL){
        var tables;
        try {
            db = new SQL.Database(new Uint8Array(arrayBuffer));

            //Get all table names from master table
            tables = db.prepare("SELECT * FROM sqlite_master WHERE type='table' OR type='view' ORDER BY UPPER(name)");
        } catch (ex) {
            setIsLoading(false);
            alert(ex);
            return;
        }

        var firstTableName = null;
        var tableList = $("#tables");

        while (tables.step()) {
            var rowObj = tables.getAsObject();
            var name = rowObj.name;

            if (firstTableName === null) {
                firstTableName = name;
            }
            var rowCount = getTableRowsCount(name);
            rowCounts[name] = rowCount;
            tableList.append('<option value="' + name + '">' + name + ' (' + rowCount + ' rows)</option>');
        }

        var table_list_wrapper = document.getElementById('table_list_wrapper');
        var letters = '';
        while (tables.step()) {

            var rowObj = tables.getAsObject();
            var name = rowObj.name;

            if (firstTableName === null) {
                firstTableName = name;
            }
            var rowCount = getTableRowsCount(name);
            rowCounts[name] = rowCount;
            // // clcickList.append('<tr value="' + name + '"> ' + name + ' (' + rowCount + ' rows)</tr>');

           // letters += "<li>"  + name + " (" +rowCount+" rows)</li>";
            letters += createCustomCard(name,rowCount);
        }
        table_list_wrapper.innerHTML = letters;
        //Select first table and show It
        tableList.select2("val", firstTableName);
        doDefaultSelect(firstTableName);
        console.log('_aaa_ 1');

        $("#output-box").fadeIn();
        $(".nouploadinfo").hide();
        $("#sample-db-link").hide();
        $("#dropzone").delay(50).animate({height: 50}, 500);
        $("#success-box").show();
        $("#table_list_wrapper").show();
        $("#myInput").show();

        // addRowHandlers();
        setIsLoading(false);
        document.getElementById("myInput").addEventListener("keyup", myFunction);
        document.getElementById("myInput").value = ""

    });
}

function createCustomCard(name, rowCount){
    const content = `
    <div class = "tableNameRow" onclick="selectTable('${name}')">
        <p  style="margin-top: 0px; margin-bottom: 0px;" >${name}</p>  
        <p  style="color: #999999;" >${rowCount} rows</p> 
    </div>
  `;
  return content;
}

function selectTable(name){
    doDefaultSelect(name);
}

function myFunction() {
    console.log('_aaa_ 2');

    var input, filter, dev, li,  i, txtValue;

    input = document.getElementById("myInput");
    dev = document.getElementById("table_list_wrapper");
    li = dev.getElementsByTagName("div");

    filter = input.value.toUpperCase();
    console.log('_aaa_ filter '+filter);
    console.log('_aaa_ li '+li);

    for (i = 0; i < li.length; i++) {
        var p = li[i].getElementsByTagName("p")[0];

        txtValue = p.textContent || p.innerText;
        console.log('_aaa_ '+txtValue+" - "+p.textContent +" - "+p.innerText);
        if (txtValue.toUpperCase().indexOf(filter) > -1) {
            li[i].style.display = "";
        } else {
            li[i].style.display = "none";
        }
    }
}

function addRowHandlers() {
    var table = document.getElementById("data");
    var rows = table.getElementsByTagName("tr");
    for (i = 0; i < rows.length; i++) {
        var currentRow = table.rows[i];
        var createClickHandler = 
            function(row) 
            {
                return function() { 
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

function setIsLoading(isLoading) {
    var dropText = $("#drop-text");
    var loading = $("#drop-loading");
    if (isLoading) {
        dropText.hide();
        loading.show();
    } else {
        dropText.show();
        loading.hide();
    }
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
    renderQuery(defaultSelect,true);
}

function executeSql() {
    var query = editor.getValue();
    renderQuery(query,false);
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
        pageToSet = (next ? limit.currentPage : limit.currentPage - 2 );
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

function htmlEncode(value){
  return $('<div/>').text(value).html();
}

function renderQuery(query,isDefualtOrder) {
    console.log('_renderQuery_ '+query)
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
    console.log('_asasasas_ -'+orderByColumn);
    while (sel.step()) {
        if (!addedColums) {
            addedColums = true;
            var columnNames = sel.getColumnNames();
            if(columnNames.length > 0){
                if(isDefualtOrder){
                    orderByColumn = columnNames[0];
                }
            }
            for (var i = 0; i < columnNames.length; i++) {
                var type = columnTypes[columnNames[i]];
                var indicater = "";
                if(orderByColumn == columnNames[i] && !isDefualtOrder){
                    if(orderByName == "ASC"){
                        indicater = "˄"
                    }else{
                        indicater = "˅"
                    }
                }
                thead.append(createTableHeader( columnNames[i],type,indicater));

            }
        }

        var tr = $('<tr>');
        var s = sel.get();
        for (var i = 0; i < s.length; i++) {
            // tr.append('<td><span title="' + htmlEncode(s[i]) + '">' + htmlEncode(s[i]) + '</span></td>');
            console.log('__SSSSSSS___ '+s[i]);
            tr.append(createTableCell(htmlEncode(s[i]),s[i],columnNames[i]));

        }
        tbody.append(tr);
    }
    
    refreshPagination(query, tableName);

    $('[data-toggle="tooltip"]').tooltip({html: true});
    dataBox.editableTableWidget();

    setTimeout(function () {
        positionFooter();
    }, 100);
    
}

function createTableHeader(name, type, indicater){
    var sortIcon;
    if (indicater === "˄") {
        sortIcon = "&#9650;";
    } else if (indicater === "˅") {
        sortIcon = "&#9660;";
    } else {
        sortIcon = "&#8597;";
    }
    var isActive = indicater !== "";
    var iconStyle = isActive
        ? "cursor:pointer;margin-left:6px;opacity:1;color:#0079FF;font-size:16px;vertical-align:middle;border:none;background:none;padding:2px 4px;line-height:1;"
        : "cursor:pointer;margin-left:6px;opacity:0.35;font-size:16px;vertical-align:middle;border:none;background:none;padding:2px 4px;line-height:1;";

    const content = `
    <th style="white-space:nowrap;">
      <span data-toggle="tooltip" data-placement="top" title="${type}">${name}</span>
      <button onclick="orderBy('${name}','${type}')" style="${iconStyle}" title="Sort by ${name}">${sortIcon}</button>
      <input type="hidden" value="${name}">
    </th>
  `;
  return content;
}

function createTableCell(data,rowValue,columnName){
    const content = `
    <td onclick="selectValue('${columnName}','${rowValue}')"><span title="' ${data} '">${data}</span></td>
  `;
  return content;
}

function orderBy(name,type){
    var tableName = document.getElementById("tableName").value
    console.log("_orderBy_ "+name);
    document.getElementById("orderByColumn").value = name;

    if(orderByName == "ASC"){
        orderByName = "DESC";
    }else{
        orderByName = "ASC";
    }
    if(type == "INTEGER"){
        editor.setValue("SELECT * FROM "+tableName+ " ORDER BY CAST("+name +" AS INTEGER) "+orderByName+" LIMIT 100");
    }else if(type == "FLOAT"){
        editor.setValue("SELECT * FROM "+tableName+ " ORDER BY CAST("+name +" AS FLOAT) "+orderByName+" LIMIT 100");
    }else if(type == "DOUBLE"){
        editor.setValue("SELECT * FROM "+tableName+ " ORDER BY CAST("+name +" AS DOUBLE) "+orderByName+" LIMIT 100");
    }else{
        editor.setValue("SELECT * FROM "+tableName+ " ORDER BY UPPER("+name +") "+orderByName+" LIMIT 100");
    }

    executeSql();
}

function selectValue(columnName,rowValue){
    var tableName = document.getElementById("tableName").value
    editor.setValue("SELECT * FROM "+tableName+ " WHERE "+columnName+" = '"+rowValue+"'");


}

function keyPressEvent(){
    document.getElementById("myInput").dispatchEvent(new KeyboardEvent('keydown', {'key': 'a'}));
}

function openSelectCoulmnsList(){
    document.getElementById("query_build_popup").style.display= "inline";
    var tableName = getTableNameFromQuery(editor.getValue()) || document.getElementById("tableName").value;
    export_query_builder_editor.setValue("SELECT * FROM '"+tableName+"'");

    var sel;
    try {
        sel = db.prepare("SELECT * FROM '"+tableName+"' LIMIT 1");
    } catch (ex) {
        showError(ex);
        return;
    }
    var addedColums = false;
    var htmlCode = ""
    while (sel.step()) {
        if (!addedColums) {
            addedColums = true;
            var columnNames = sel.getColumnNames();
            for (var i = 0; i < columnNames.length; i++) {
                htmlCode+=culumnCheckBuilder(columnNames[i]);
            }
        }


    }
    document.getElementById("column_chck_box").innerHTML = htmlCode;

    // Remove old listeners by cloning and replacing export buttons
    ["confirm_export_sql","confirm_export_json","confirm_export_csv","confirm_export_xml","confirm_export_excel"].forEach(function(id){
        var old = document.getElementById(id);
        var fresh = old.cloneNode(true);
        old.parentNode.replaceChild(fresh, old);
    });

    var checkboxes = document.querySelectorAll("input[type=checkbox][name=export_columns]");
    let enabledSettings = Array.from(checkboxes).map(i => i.value);
    var currentTableName = document.getElementById("tableName").value

    

    checkboxes.forEach(function(checkbox) {
    checkbox.addEventListener('change', function() {
        enabledSettings = 
        Array.from(checkboxes) // Convert checkboxes to an array to use filter and map.
        .filter(i => i.checked) // Use Array.filter to remove unchecked checkboxes.
        .map(i => i.value) // Use Array.map to extract only the checkbox values from the array of objects.

        export_query_builder_editor.setValue("SELECT "+enabledSettings.toString()+" FROM "+currentTableName);

    })
    });

    enabledSettings = Array.from(checkboxes) // Convert checkboxes to an array to use filter and map.
        .filter(i => i.checked) // Use Array.filter to remove unchecked checkboxes.
        .map(i => i.value) // Use Array.map to extract only the checkbox values from the array of objects.

        export_query_builder_editor.setValue("SELECT "+enabledSettings.toString()+" FROM "+currentTableName);


    document.getElementById("confirm_export_sql").addEventListener("click", function() {
        exportToSQL(enabledSettings);
    });
      
    document.getElementById("confirm_export_csv").addEventListener("click", function() {
        exportToCSV(enabledSettings);
    }); 

    document.getElementById("confirm_export_xml").addEventListener("click", function() {
        exportToXML(enabledSettings);
    }); 

    document.getElementById("confirm_export_json").addEventListener("click", function() {
        exportToJSON(enabledSettings);
    });

    document.getElementById("confirm_export_excel").addEventListener("click", function() {
        exportToExcel(enabledSettings);
    });
}

function culumnCheckBuilder(columnName){
    const content = `
    <input type="checkbox" id="'${columnName}'" name="export_columns" value="${columnName}" checked>
    <label for="'${columnName}'">${columnName}</label><br>

  `;
  return content;
}

function dismissColumnSelectDialog(){
    document.getElementById("query_build_popup").style.display= "none";

}

function buildInsertQuery(columnNames){
    var tableName = document.getElementById("tableName").value
    console.log("tableName = <"+tableName+">")
    var sel;
    try {
        sel = db.prepare(export_query_builder_editor.getValue());
    } catch (ex) {
        showError(ex);
        return;
    }
    var addedColums = false;
    var baseQuery = "INSERT INTO "+tableName+" ("
    var queryPreFix = ""
    while (sel.step()) {

        if (!addedColums) {
            addedColums = true;
            var columnString = "";
            var columnPreFix = ""
            for (var i = 0; i < columnNames.length; i++) {
                columnString+=columnPreFix;
                columnPreFix = ","
                columnString+=columnNames[i]
            }
            baseQuery+=columnString+") VALUES "
        }

        
        var valuePreFix = ""
        var valueQuery = "";
        var s = sel.get();
        for (var i = 0; i < s.length; i++) {
            valueQuery+=valuePreFix;
            valuePreFix = ","
            valueQuery+="'"+s[i]+"'";            
            // tr.append('<td><span title="' + htmlEncode(s[i]) + '">' + htmlEncode(s[i]) + '</span></td>');
        }
        baseQuery+=queryPreFix;
        queryPreFix=","
        baseQuery+="\n("
        baseQuery+=valueQuery;
        baseQuery+=")"

    }
    download(tableName+".sql", baseQuery, type="text/plain")
    document.getElementById("query_build_popup").style.display= "none";
}

function getExportFileName(tableName, ext) {
    var now = new Date();
    var pad = function(n) { return String(n).padStart(2, '0'); };
    var datePart = now.getFullYear() + '-' + pad(now.getMonth()+1) + '-' + pad(now.getDate());
    var timePart = pad(now.getHours()) + '-' + pad(now.getMinutes()) + '-' + pad(now.getSeconds());
    var safeName = (tableName || 'export').replace(/[\/\:*?"<>|]/g, '_');
    return safeName + '_' + datePart + ' ' + timePart + '.' + ext;
}

function exportToSQL(columnNames){
    var tableName = document.getElementById("tableName").value

    var result = buildInsertQuery2(columnNames);
      
      
    var insertQuery = 'INSERT INTO ' + tableName + ' (';
    var values = [];
    
    // Get the column names from the first row of the result array
    var columnNames = Object.keys(result[0]);
    insertQuery += columnNames.join(', ');
    
    result.forEach(function(row) {
    var rowValues = columnNames.map(function(column) {
        return "'" + row[column] + "'";
    });
    var rowString = '(' + rowValues.join(', ') + ')\n';
    values.push(rowString);
    });
    
    insertQuery += ') VALUES \n';
    insertQuery += values.join(', ');
    download(getExportFileName(tableName, 'sql'), insertQuery, type="text/plain")

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

function pragma(){
    var tableName = document.getElementById("tableName").value

    export_query_builder_editor.setValue("PRAGMA table_info("+tableName+")");

    editor.setValue("PRAGMA table_info("+tableName+")");

    executeSql();
}



function exportToCSV(columnNames){
    var result = buildInsertQuery2(columnNames);

    if (!result || result.length === 0) return;
      
    var csvContent = 'data:text/csv;charset=utf-8,';
    
    // Add headers row
    var headers = Object.keys(result[0]).map(function(h) { return '"' + h + '"'; });
    csvContent += headers.join(',') + '\n';
    
    // Generate the CSV content
    result.forEach(function(row) {
    var rowValues = Object.values(row).map(function(value) {
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
 
function exportToXML(columnNames){
    var result = buildInsertQuery2(columnNames);

    var xmlContent = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xmlContent += '<root>\n';
    
    // Generate the XML content
    result.forEach(function(row) {
    xmlContent += '  <row>\n';
    
    Object.keys(row).forEach(function(column) {
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

function exportToJSON(columnNames){
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

function exportToExcel(columnNames){
    var result = buildInsertQuery2(columnNames);
    if (!result || result.length === 0) return;

    var tableName = getTableNameFromQuery(export_query_builder_editor.getValue()) || 'export';
    var ws = XLSX.utils.json_to_sheet(result);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tableName.substring(0, 31));
    XLSX.writeFile(wb, getExportFileName(tableName, 'xlsx'));
}

function excelImportClick(){
    document.getElementById("excel-import-dialog").click();
}

function importExcelFile(file){
    setIsLoading(true);
    var reader = new FileReader();
    reader.onload = function(e){
        try {
            var data = new Uint8Array(e.target.result);
            var workbook = XLSX.read(data, {type: 'array'});

            var sqlStatements = '';
            workbook.SheetNames.forEach(function(sheetName){
                var ws = workbook.Sheets[sheetName];
                var rows = XLSX.utils.sheet_to_json(ws, {defval: null});
                if (!rows || rows.length === 0) return;

                var safeName = sheetName.replace(/[^a-zA-Z0-9_]/g, '_');
                var cols = Object.keys(rows[0]);

                sqlStatements += 'DROP TABLE IF EXISTS "' + safeName + '";\n';
                sqlStatements += 'CREATE TABLE "' + safeName + '" (\n  ';
                sqlStatements += cols.map(function(c){ return '"' + c + '" TEXT'; }).join(',\n  ');
                sqlStatements += '\n);\n';

                rows.forEach(function(row){
                    var vals = cols.map(function(c){
                        var v = row[c];
                        if (v === null || v === undefined) return 'NULL';
                        return "'" + String(v).replace(/'/g, "''") + "'";
                    });
                    sqlStatements += 'INSERT INTO "' + safeName + '" VALUES (' + vals.join(', ') + ');\n';
                });
                sqlStatements += '\n';
            });

            initSqlJs().then(function(SQL){
                try {
                    if (!db) db = new SQL.Database();
                    db.run(sqlStatements);

                    resetTableList();
                    var tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' OR type='view' ORDER BY UPPER(name)");
                    var firstTableName = null;
                    var tableList = $("#tables");
                    var letters = '';
                    while(tables.step()){
                        var rowObj = tables.getAsObject();
                        var name = rowObj.name;
                        if(!firstTableName) firstTableName = name;
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
                    $("#dropzone").delay(50).animate({height: 50}, 500);
                    $("#table_list_wrapper").show();
                    $("#myInput").show();
                    document.getElementById("myInput").addEventListener("keyup", myFunction);
                    document.getElementById("myInput").value = "";
                } catch(ex){
                    alert("Error importing Excel: " + ex);
                } finally {
                    setIsLoading(false);
                }
            });
        } catch(ex){
            setIsLoading(false);
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

  function download(filename, text, type="text/plain") {
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