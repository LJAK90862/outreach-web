const DISCORD_WEBHOOK = "https://discord.com/api/webhooks/1483065479508525238/Ur5R3bFP7dOmele9gX0gSdSwVMz7C5ahw05bHIcPdkBapk9qgOlzFLCgt70Ffel5Z2n4";
const FOLDER_ID = "1I7dMYHF5pkhQ34izTu8geZrkFk79F2lG";

const DISCORD_LIMIT = 2000;
const MAX_SUMMARY_LEN = 450;
const MIN_DOC_AGE_MINUTES = 10;
const MAX_EXTRA_CHUNKS = 6;

function checkForNewMeetingNotes() {
  Logger.log("Running check at " + new Date());

  const props = PropertiesService.getScriptProperties();
  const files = listFilesInFolder_(FOLDER_ID);

  Logger.log(`Found ${files.length} files in folder`);

  for (const file of files) {
    const fileId = file.id;
    const fileName = file.name || "Untitled";

    Logger.log(`Checking: ${fileName} (${fileId})`);

    if (props.getProperty(fileId)) {
      Logger.log(`Skip already posted: ${fileName}`);
      continue;
    }

    // Skip files that are too new (still being written by Meet)
    const created = new Date(file.createdTime);
    const ageMinutes = (Date.now() - created.getTime()) / 60000;
    if (ageMinutes < MIN_DOC_AGE_MINUTES) {
      Logger.log(`Skip too new (${Math.round(ageMinutes)}m): ${fileName}`);
      continue;
    }

    // Get document content
    const content = getDocContent_(fileId);
    if (!content || content.trim().length < 50) {
      Logger.log(`Skip empty/short doc: ${fileName}`);
      continue;
    }

    Logger.log(`Posting: ${fileName} (${content.length} chars)`);

    // Build Discord message
    const summary = buildSummary_(content);
    const driveLink = `https://docs.google.com/document/d/${fileId}/edit`;

    // First message: header + summary
    const header = `:clipboard: **New Meeting Transcript**\n` +
      `:page_facing_up: **${fileName}**\n` +
      `:calendar: ${formatDate_(created)}\n` +
      `:link: [Open in Google Docs](${driveLink})\n\n` +
      `**Summary:**\n${summary}`;

    sendToDiscord_(header);

    // Send full transcript in chunks
    const fullText = `**Full Transcript — ${fileName}**\n\n${content}`;
    const chunks = chunkText_(fullText, DISCORD_LIMIT - 50);

    const chunksToSend = Math.min(chunks.length, MAX_EXTRA_CHUNKS + 1);
    for (let i = 0; i < chunksToSend; i++) {
      Utilities.sleep(1000); // Rate limit
      const prefix = chunks.length > 1 ? `*(${i + 1}/${chunks.length})*\n` : "";
      sendToDiscord_(prefix + chunks[i]);
    }

    if (chunks.length > chunksToSend) {
      Utilities.sleep(1000);
      sendToDiscord_(`:scissors: *Transcript truncated — ${chunks.length - chunksToSend} more chunk(s). See full doc: [Open](${driveLink})*`);
    }

    // Mark as posted
    props.setProperty(fileId, new Date().toISOString());
    Logger.log(`Posted: ${fileName}`);
  }

  Logger.log("Check complete");
}


// ── Helpers ─────────────────────────────────────────────────────

function listFilesInFolder_(folderId) {
  const url = `https://www.googleapis.com/drive/v3/files?` +
    `q='${folderId}'+in+parents+and+trashed=false` +
    `&fields=files(id,name,createdTime,mimeType)` +
    `&orderBy=createdTime+desc` +
    `&pageSize=20`;

  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });

  const data = JSON.parse(resp.getContentText());
  return data.files || [];
}


function getDocContent_(fileId) {
  try {
    // Try Google Docs export first
    const url = `https://docs.google.com/document/d/${fileId}/export?format=txt`;
    const resp = UrlFetchApp.fetch(url, {
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });

    if (resp.getResponseCode() === 200) {
      return resp.getContentText().trim();
    }

    // Fallback: try Drive API export
    const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`;
    const driveResp = UrlFetchApp.fetch(driveUrl, {
      headers: { Authorization: "Bearer " + ScriptApp.getOAuthToken() },
      muteHttpExceptions: true
    });

    if (driveResp.getResponseCode() === 200) {
      return driveResp.getContentText().trim();
    }

    Logger.log(`Could not export doc ${fileId}: ${driveResp.getResponseCode()}`);
    return "";
  } catch (e) {
    Logger.log(`Error reading doc ${fileId}: ${e.message}`);
    return "";
  }
}


function buildSummary_(content) {
  // Extract key lines: look for speaker names, action items, decisions
  const lines = content.split("\n").filter(l => l.trim().length > 0);

  // Try to find structured sections
  const keyPhrases = ["action item", "decision", "next step", "follow up", "agreed", "todo"];
  const keyLines = lines.filter(l => {
    const lower = l.toLowerCase();
    return keyPhrases.some(p => lower.includes(p));
  });

  let summary = "";

  if (keyLines.length > 0) {
    summary = "**Key points:**\n" + keyLines.slice(0, 5).map(l => `> ${l.trim()}`).join("\n");
  } else {
    // Fallback: first few meaningful lines
    const meaningful = lines.filter(l => l.trim().length > 20).slice(0, 5);
    summary = meaningful.map(l => `> ${l.trim().substring(0, 150)}`).join("\n");
  }

  if (summary.length > MAX_SUMMARY_LEN) {
    summary = summary.substring(0, MAX_SUMMARY_LEN) + "...";
  }

  return summary || "> *(No summary could be extracted)*";
}


function chunkText_(text, maxLen) {
  const chunks = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a newline
    let breakPoint = remaining.lastIndexOf("\n", maxLen);
    if (breakPoint < maxLen * 0.5) {
      // No good newline break, try space
      breakPoint = remaining.lastIndexOf(" ", maxLen);
    }
    if (breakPoint < maxLen * 0.3) {
      breakPoint = maxLen; // Hard break
    }

    chunks.push(remaining.substring(0, breakPoint));
    remaining = remaining.substring(breakPoint).trim();
  }

  return chunks;
}


function sendToDiscord_(message) {
  if (message.length > DISCORD_LIMIT) {
    message = message.substring(0, DISCORD_LIMIT - 3) + "...";
  }

  const payload = { content: message };

  const resp = UrlFetchApp.fetch(DISCORD_WEBHOOK, {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  if (resp.getResponseCode() !== 204 && resp.getResponseCode() !== 200) {
    Logger.log(`Discord error ${resp.getResponseCode()}: ${resp.getContentText()}`);
  }
}


function formatDate_(date) {
  const options = { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" };
  return date.toLocaleDateString("en-US", options);
}


// ── Setup ───────────────────────────────────────────────────────

function createTrigger() {
  // Delete existing triggers for this function
  const triggers = ScriptApp.getProjectTriggers();
  for (const trigger of triggers) {
    if (trigger.getHandlerFunction() === "checkForNewMeetingNotes") {
      ScriptApp.deleteTrigger(trigger);
    }
  }

  // Run every 10 minutes
  ScriptApp.newTrigger("checkForNewMeetingNotes")
    .timeBased()
    .everyMinutes(10)
    .create();

  Logger.log("Trigger created: checkForNewMeetingNotes every 10 minutes");
}


function resetPostedHistory() {
  // Use this to re-post all files (e.g., after testing)
  PropertiesService.getScriptProperties().deleteAllProperties();
  Logger.log("Cleared all posted file history");
}


function testRun() {
  // Manual test - run this first to authorize permissions
  checkForNewMeetingNotes();
}
