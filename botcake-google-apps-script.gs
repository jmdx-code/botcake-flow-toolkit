// BotCake 订阅记录同步脚本（Google Apps Script / V8）
//
// 保持原调用方式不变：
// botCakes(pageId, sheetName, timeZone, startdate, token, pageName)
//
// 旧调用会读取 startdate 至“该时区今天”的数据。
// 如需指定结束日期，可在末尾追加可选参数：
// botCakes(pageId, sheetName, timeZone, startdate, token, pageName, enddate)

var page_size = 100;
var page = 1; // 仅为兼容旧脚本中可能引用此全局变量的代码。
var MAX_PAGES = 500;
var WRITE_BATCH_SIZE = 1000;

var BOTCAKE_COLUMNS = [
  "姓名",
  "自定义字段",
  "来源",
  "标签",
  "日期",
  "评论贴文",
  "评论ID",
  "订阅时间",
  "性别",
  "所属地",
  "id",
  "时间段",
  "专页ID"
];

/**
 * 同步 BotCake 订阅记录。
 *
 * 原有六参数调用完全兼容。enddate 是可选的第七个参数；省略时取今天。
 */
function botCakes(pageId, sheetName, timeZone, startdate, token, pageName, enddate) {
  if (!token || String(token).length <= 100) {
    SpreadsheetApp.getUi().alert("⛔ 请检查Token");
    return;
  }

  timeZone = timeZone || Session.getScriptTimeZone();
  assertValidTimeZone(timeZone);

  var startDate = normalizeDateInput(startdate, timeZone, "开始日期");
  var endDate = isEmptyValue(enddate)
    ? Utilities.formatDate(new Date(), timeZone, "yyyy-MM-dd")
    : normalizeDateInput(enddate, timeZone, "结束日期");

  if (startDate > endDate) {
    throw new Error("开始日期不能晚于结束日期：" + startDate + " > " + endDate);
  }

  Logger.log("开始读取 BotCake 数据，日期范围：" + startDate + " 至 " + endDate);

  // 所有分页成功后才修改表格，防止接口中途失败却写入不完整数据。
  var data = fetchBotCakeData(
    pageId,
    token,
    pageName,
    startDate,
    endDate,
    timeZone
  );

  // 网络读取完成后再加表格锁。锁内重新读取已有数据，避免两个触发器
  // 同时判断为“不存在”并重复写入相同订阅事件。
  var lock = LockService.getDocumentLock();
  lock.waitLock(30000);

  try {
  var spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = spreadsheet.getSheetByName(sheetName);

  if (!sheet) {
    throw new Error("找不到工作表：" + sheetName);
  }

  var values = sheet.getDataRange().getValues();
  var idIndex = BOTCAKE_COLUMNS.indexOf("id");
  var subscribedIndex = BOTCAKE_COLUMNS.indexOf("订阅时间");
  var sortDateIndex = subscribedIndex;

  // 订阅事件的唯一键是“客户 ID + BotCake last_subscribed_at”。
  // 同一客户在不同时间重新订阅时会保留多行；同一次事件不会重复写入。
  var existingEventKeys = Object.create(null);
  var spreadsheetTimeZone = spreadsheet.getSpreadsheetTimeZone() || timeZone;

  for (var rowIndex = 1; rowIndex < values.length; rowIndex++) {
    var existingId = String(values[rowIndex][idIndex] || "").trim();
    var existingSubscribedAt = normalizeExistingSubscribedAt(
      values[rowIndex][subscribedIndex],
      spreadsheetTimeZone
    );

    if (existingId && existingSubscribedAt) {
      existingEventKeys[existingId + ":" + existingSubscribedAt] = true;
    }
  }

  var newRows = [];
  var duplicateCount = 0;
  var invalidDateCount = 0;
  var outsideRangeCount = 0;

  data.forEach(function (item) {
    // 严格使用 BotCake 订阅时间，不使用创建时间或交互时间回退。
    var subscribedTimestamp = item.last_subscribed_at;

    var subscribedDate = convertTimestampToDate(subscribedTimestamp, timeZone);

    if (!subscribedDate) {
      invalidDateCount++;
      Logger.log(
        "跳过无效订阅时间，客户=" +
        String(item.id || item.psid || "未知") +
        "，原值=" +
        String(subscribedTimestamp)
      );
      return;
    }

    var subscribedDay = subscribedDate.substring(0, 10);

    // 服务端已经筛选；这里再次校验，避免接口边界或时区行为变化。
    if (subscribedDay < startDate || subscribedDay > endDate) {
      outsideRangeCount++;
      return;
    }

    var iid = String(item.id || item.psid || "").trim();

    if (!iid) {
      Logger.log("跳过没有 id/psid 的记录：" + JSON.stringify(item));
      return;
    }

    var eventKey = iid + ":" + subscribedDate;

    if (existingEventKeys[eventKey]) {
      duplicateCount++;
      return;
    }

    // 立即登记，防止本次 API 分页中出现相同订阅事件时重复写入。
    existingEventKeys[eventKey] = true;

    var postData = buildPostData(item.post_id);
    var gender = normalizeGender(item.gender);

    newRows.push([
      item.full_name || "",
      "",
      item.source || "",
      "",
      subscribedDay,
      postData.link,
      postData.commentId,
      subscribedDate,
      gender,
      "",
      iid,
      subscribedDate.substring(11, 13),
      pageId
    ]);
  });

  newRows.sort(function (a, b) {
    return strcmp(b[sortDateIndex], a[sortDateIndex]);
  });

  // 始终修正表头，但不清除旧数据。
  sheet.getRange(1, 1, 1, BOTCAKE_COLUMNS.length).setValues([BOTCAKE_COLUMNS]);

  if (newRows.length > 0) {
    sheet.insertRowsBefore(2, newRows.length);

    for (var offset = 0; offset < newRows.length; offset += WRITE_BATCH_SIZE) {
      var rows = newRows.slice(offset, offset + WRITE_BATCH_SIZE);
      // 订阅时间按文本保存，避免 Google Sheets 按表格时区再次转换。
      sheet
        .getRange(2 + offset, subscribedIndex + 1, rows.length, 1)
        .setNumberFormat("@");
      sheet
        .getRange(2 + offset, 1, rows.length, BOTCAKE_COLUMNS.length)
        .setValues(rows);
    }
  }

  Logger.log("BotCake 接口返回（分页去重后）：" + data.length);
  Logger.log("新增写入：" + newRows.length);
  Logger.log("表格已有或接口分页重复：" + duplicateCount);
  Logger.log("接口返回但不在日期范围：" + outsideRangeCount);
  Logger.log("无效订阅时间：" + invalidDateCount);
  Logger.log("数据写入完毕");
  } finally {
    lock.releaseLock();
  }
}

/**
 * 按 BotCake 的 last_subscribed ranger 过滤器读取完整分页。
 */
function fetchBotCakeData(pageId, token, pageName, startDate, endDate, timeZone) {
  // 保留对旧式三参数直接调用的兼容；此时读取当天。
  timeZone = timeZone || Session.getScriptTimeZone();
  startDate = isEmptyValue(startDate)
    ? Utilities.formatDate(new Date(), timeZone, "yyyy-MM-dd")
    : normalizeDateInput(startDate, timeZone, "开始日期");
  endDate = isEmptyValue(endDate)
    ? Utilities.formatDate(new Date(), timeZone, "yyyy-MM-dd")
    : normalizeDateInput(endDate, timeZone, "结束日期");

  var filter = buildBotCakeDateFilter(startDate, endDate, timeZone);
  var firstResult = fetchBotCakeCustomerPage(pageId, token, pageName, 1, filter);
  var firstBatch = extractBotCakeCustomers(firstResult);
  var rows = firstBatch.slice();
  var totalEntries = extractBotCakeTotalEntries(firstResult);

  Logger.log("第 1 页：" + firstBatch.length + " 条；total_entries=" + totalEntries);

  if (totalEntries > 0) {
    var pageCount = Math.ceil(totalEntries / page_size);

    if (pageCount > MAX_PAGES) {
      throw new Error(
        "所选日期范围共有 " + totalEntries + " 条，超过安全分页上限 " + MAX_PAGES + " 页"
      );
    }

    for (var pageNumber = 2; pageNumber <= pageCount; pageNumber++) {
      var result = fetchBotCakeCustomerPage(pageId, token, pageName, pageNumber, filter);
      var batch = extractBotCakeCustomers(result);
      rows = rows.concat(batch);
      Logger.log("第 " + pageNumber + "/" + pageCount + " 页：" + batch.length + " 条");
    }
  } else if (firstBatch.length >= page_size) {
    // 兼容没有 total_entries 的旧版响应，顺序读取到空页或短页。
    var previousSignature = getBatchSignature(firstBatch);

    for (var fallbackPage = 2; fallbackPage <= MAX_PAGES; fallbackPage++) {
      var fallbackResult = fetchBotCakeCustomerPage(
        pageId,
        token,
        pageName,
        fallbackPage,
        filter
      );
      var fallbackBatch = extractBotCakeCustomers(fallbackResult);

      if (!fallbackBatch.length) {
        break;
      }

      var signature = getBatchSignature(fallbackBatch);
      if (signature === previousSignature) {
        throw new Error(
          "BotCake 第 " + fallbackPage + " 页与上一页相同，接口可能忽略了 page 参数"
        );
      }

      previousSignature = signature;
      rows = rows.concat(fallbackBatch);
      Logger.log("第 " + fallbackPage + " 页：" + fallbackBatch.length + " 条");

      if (fallbackBatch.length < page_size) {
        break;
      }

      if (fallbackPage === MAX_PAGES) {
        throw new Error("读取达到安全分页上限 " + MAX_PAGES + " 页");
      }
    }
  }

  // 页面数据发生移动时，相邻分页可能重叠；按客户事件去重。
  var seen = Object.create(null);
  var deduplicated = [];

  rows.forEach(function (customer) {
    var timestamp = customer.last_subscribed_at;
    var customerId = String(customer.id || customer.psid || "");
    var key = customerId + ":" + String(timestamp);

    if (!seen[key]) {
      seen[key] = true;
      deduplicated.push(customer);
    }
  });

  // total_entries 是 BotCake 对当前筛选范围声明的总数。任何少页或分页移动
  // 都不能静默通过，否则上层会误以为同步成功。
  if (totalEntries > 0 && rows.length < totalEntries) {
    throw new Error(
      "BotCake 声明共有 " +
      totalEntries +
      " 条，但分页只返回 " +
      rows.length +
      " 条；为避免漏数据，本次未写入，请重新执行"
    );
  }

  if (totalEntries > 0 && deduplicated.length < totalEntries) {
    throw new Error(
      "BotCake 分页期间数据发生重复或移动：应有 " +
      totalEntries +
      " 条，去重后只有 " +
      deduplicated.length +
      " 条；为避免漏数据，本次未写入，请重新执行"
    );
  }

  return deduplicated;
}

/**
 * 读取单页。失败会重试；最终失败直接抛错，不会把失败页当成空页。
 */
function fetchBotCakeCustomerPage(pageId, token, pageName, pageNumber, filter) {
  var apiPageId = String(pageName || "").includes("IG")
    ? "igo_" + String(pageId)
    : String(pageId);

  var url =
    "https://botcake.io/api/v1/pages/" +
    encodeURIComponent(apiPageId) +
    "/customers?page_size=" +
    page_size +
    "&page=" +
    pageNumber +
    "&access_token=" +
    encodeURIComponent(token);

  // UrlFetchApp 会把普通对象 payload 编码为表单字段，对应插件里的 FormData。
  var options = {
    method: "post",
    payload: {
      "filter[0][type]": "last_subscribed",
      "filter[0][filter_type]": "ranger",
      "filter[0][unit]": filter.unit,
      "filter[0][start_date]": String(filter.startSeconds),
      "filter[0][end_date]": String(filter.endSeconds)
    },
    muteHttpExceptions: true
  };

  var maxAttempts = 3;
  var lastError = "未知错误";

  for (var attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      var response = UrlFetchApp.fetch(url, options);
      var status = response.getResponseCode();
      var text = response.getContentText();

      if (status >= 200 && status < 300) {
        try {
          return text ? JSON.parse(text) : {};
        } catch (parseError) {
          lastError = "响应不是有效 JSON：" + parseError.message;
        }
      } else {
        lastError = "HTTP " + status + "：" + text.substring(0, 500);

        // 除 429 外的 4xx 通常重试没有意义。
        if (status >= 400 && status < 500 && status !== 429) {
          break;
        }
      }
    } catch (error) {
      lastError = error && error.message ? error.message : String(error);
    }

    if (attempt < maxAttempts) {
      Utilities.sleep(attempt * 1000);
    }
  }

  throw new Error(
    "读取 BotCake 第 " + pageNumber + " 页失败，未写入任何新数据。原因：" + lastError
  );
}

/**
 * BotCake 的 ranger 使用秒级闭区间。
 */
function buildBotCakeDateFilter(startDate, endDate, timeZone) {
  var startMilliseconds = zonedDateStartMilliseconds(startDate, timeZone);
  var endExclusiveMilliseconds = zonedDateStartMilliseconds(addIsoDays(endDate, 1), timeZone);

  return {
    unit: startDate === endDate ? "hour" : "day",
    startSeconds: Math.floor(startMilliseconds / 1000),
    endSeconds: Math.floor(endExclusiveMilliseconds / 1000) - 1
  };
}

/**
 * 返回指定 IANA 时区中某日 00:00:00 对应的 UTC 毫秒值，兼容夏令时。
 */
function zonedDateStartMilliseconds(dateText, timeZone) {
  var dateParts = dateText.split("-").map(Number);
  var desiredAsUtc = Date.UTC(dateParts[0], dateParts[1] - 1, dateParts[2]);
  var guess = desiredAsUtc;

  for (var attempt = 0; attempt < 3; attempt++) {
    var parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(guess));

    function read(type) {
      for (var i = 0; i < parts.length; i++) {
        if (parts[i].type === type) {
          return Number(parts[i].value);
        }
      }
      return 0;
    }

    var representedAsUtc = Date.UTC(
      read("year"),
      read("month") - 1,
      read("day"),
      read("hour"),
      read("minute"),
      read("second")
    );
    var correction = desiredAsUtc - representedAsUtc;
    guess += correction;

    if (correction === 0) {
      break;
    }
  }

  return guess;
}

function extractBotCakeCustomers(value) {
  if (Array.isArray(value)) {
    return value.filter(function (item) {
      return item && typeof item === "object" && !Array.isArray(item);
    });
  }

  if (!value || typeof value !== "object") {
    return [];
  }

  var preferredKeys = ["customers", "data", "items"];

  for (var i = 0; i < preferredKeys.length; i++) {
    var found = value[preferredKeys[i]];

    if (Array.isArray(found)) {
      return extractBotCakeCustomers(found);
    }

    if (found && typeof found === "object") {
      var nested = extractBotCakeCustomers(found);
      if (nested.length) {
        return nested;
      }
    }
  }

  return [];
}

function extractBotCakeTotalEntries(value) {
  if (!value || typeof value !== "object") {
    return 0;
  }

  var queue = [value];
  var visited = [];

  while (queue.length && visited.length < 200) {
    var current = queue.shift();

    if (!current || typeof current !== "object" || visited.indexOf(current) >= 0) {
      continue;
    }

    visited.push(current);

    // 不读取泛用的 count，避免误把其他统计字段当成客户总数。
    var keys = ["total_entries", "totalEntries", "total"];

    for (var i = 0; i < keys.length; i++) {
      var numeric = Number(current[keys[i]]);
      if (isFinite(numeric) && numeric >= 0) {
        return Math.floor(numeric);
      }
    }

    Object.keys(current).forEach(function (key) {
      var child = current[key];
      if (child && typeof child === "object" && !Array.isArray(child)) {
        queue.push(child);
      }
    });
  }

  return 0;
}

function getBatchSignature(batch) {
  if (!batch.length) {
    return "";
  }

  var first = batch[0];
  var last = batch[batch.length - 1];

  return [
    String(first.id || first.psid || ""),
    String(last.id || last.psid || ""),
    String(batch.length)
  ].join(":");
}

function buildPostData(postId) {
  if (postId === null || postId === undefined || postId === "") {
    return { link: "", commentId: "" };
  }

  var text = String(postId);
  var separatorIndex = text.lastIndexOf("_");

  return {
    link: "https://fb.com/" + text,
    commentId: separatorIndex >= 0 ? "#" + text.substring(separatorIndex + 1) : text
  };
}

function normalizeGender(value) {
  if (value === 2 || value === "2") {
    return "女";
  }
  if (value === 1 || value === "1") {
    return "男";
  }

  var normalized = String(value === null || value === undefined ? "" : value)
    .trim()
    .toLowerCase();

  if (["female", "f", "woman", "women", "女"].indexOf(normalized) >= 0) {
    return "女";
  }
  if (["male", "m", "man", "men", "男"].indexOf(normalized) >= 0) {
    return "男";
  }

  return "";
}

/**
 * 将旧表中的订阅时间还原成事件键使用的 yyyy-MM-dd HH:mm:ss。
 * 新写入的数据是纯文本；旧数据如果被 Sheets 解析成 Date，则使用
 * 表格自身时区还原其原有墙上时间，避免重复同步。
 */
function normalizeExistingSubscribedAt(value, spreadsheetTimeZone) {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    if (isNaN(value.getTime())) {
      return "";
    }
    return Utilities.formatDate(value, spreadsheetTimeZone, "yyyy-MM-dd HH:mm:ss");
  }

  var text = String(value || "").trim();

  // 兼容文本中使用斜线日期的旧行。
  var match = text.match(/^(\d{4})[\/-](\d{1,2})[\/-](\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
  if (match) {
    return [
      String(match[1]).padStart(4, "0") + "-" +
        String(match[2]).padStart(2, "0") + "-" +
        String(match[3]).padStart(2, "0"),
      String(match[4]).padStart(2, "0") + ":" +
        String(match[5]).padStart(2, "0") + ":" +
        String(match[6]).padStart(2, "0")
    ].join(" ");
  }

  return text;
}

function normalizeDateInput(value, timeZone, fieldName) {
  if (Object.prototype.toString.call(value) === "[object Date]") {
    if (isNaN(value.getTime())) {
      throw new Error(fieldName + "不是有效日期");
    }
    return Utilities.formatDate(value, timeZone, "yyyy-MM-dd");
  }

  var text = String(value || "").trim();
  var match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

  if (match) {
    return validateAndFormatDate(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
      fieldName
    );
  }

  match = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);

  if (match) {
    return validateAndFormatDate(
      Number(match[3]),
      Number(match[2]),
      Number(match[1]),
      fieldName
    );
  }

  throw new Error(
    fieldName + "格式不正确，请使用 yyyy-MM-dd、dd/MM/yyyy 或表格日期单元格。收到：" + text
  );
}

function validateAndFormatDate(year, month, day, fieldName) {
  var date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(fieldName + "不是有效日期");
  }

  return [
    String(year).padStart(4, "0"),
    String(month).padStart(2, "0"),
    String(day).padStart(2, "0")
  ].join("-");
}

function addIsoDays(dateText, amount) {
  var date = new Date(dateText + "T00:00:00Z");
  date.setUTCDate(date.getUTCDate() + amount);
  return Utilities.formatDate(date, "UTC", "yyyy-MM-dd");
}

function assertValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timeZone }).format(new Date());
  } catch (error) {
    throw new Error("无效时区：" + timeZone);
  }
}

function isEmptyValue(value) {
  return value === null || value === undefined || String(value).trim() === "";
}

function firstPresentValue(values) {
  for (var i = 0; i < values.length; i++) {
    if (!isEmptyValue(values[i])) {
      return values[i];
    }
  }
  return "";
}

// 同时兼容秒级时间戳、毫秒级时间戳和 ISO 日期字符串。
function convertTimestampToDate(timestamp, timeZone) {
  if (isEmptyValue(timestamp)) {
    return "";
  }

  var date;

  if (typeof timestamp === "number") {
    date = new Date(timestamp < 1000000000000 ? timestamp * 1000 : timestamp);
  } else if (
    typeof timestamp === "string" &&
    /^\d+(\.\d+)?([eE][+-]?\d+)?$/.test(timestamp.trim())
  ) {
    var numeric = Number(timestamp);
    date = new Date(numeric < 1000000000000 ? numeric * 1000 : numeric);
  } else {
    date = new Date(timestamp);
  }

  if (isNaN(date.getTime())) {
    return "";
  }

  return Utilities.formatDate(date, timeZone, "yyyy-MM-dd HH:mm:ss");
}

function strcmp(a, b) {
  a = String(a);
  b = String(b);

  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
