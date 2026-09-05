const REPOSITORY = "WayBurb/wayburb-public-issues";
const FEEDBACK_EXPORT_URL =
  "https://australia-southeast1-way-burb-fjba70.cloudfunctions.net/wayburbFeedbackExport";

function sanitizeFeedback(value) {
  return String(value || "")
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email removed]")
    .replace(/(?:\+?61|0)[2-478](?:[ -]?\d){8}/g, "[phone removed]")
    .replace(/\b(?:uid|user\s*id|account\s*id)\s*[:=#-]?\s*[A-Za-z0-9_-]{6,}\b/gi, "[user identifier removed]")
    .replace(/\b(?:access[_ -]?token|api[_ -]?key|secret)\s*[:=]\s*\S+/gi, "[credential removed]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 8000);
}

function tokens(value) {
  const ignored = new Set([
    "about", "after", "again", "also", "because", "could", "from", "have",
    "into", "just", "that", "their", "there", "this", "when", "where",
    "which", "with", "would", "your",
  ]);
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9]{3,}/g)
    ?.filter((word) => !ignored.has(word)) || []);
}

function similarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return intersection / Math.min(a.size, b.size);
}

function marker(id) {
  return `report-feedback-id:${id}`;
}

async function githubRequest(path, options = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    ...options,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "wayburb-feedback-automation",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub ${response.status}: ${(await response.text()).slice(0, 500)}`);
  }
  if (response.status === 204) return null;
  return response.json();
}

async function listIssues() {
  const issues = [];
  for (let page = 1; page <= 10; page += 1) {
    const batch = await githubRequest(
      `/repos/${REPOSITORY}/issues?state=all&per_page=100&page=${page}`,
    );
    issues.push(...batch.filter((item) => !item.pull_request));
    if (batch.length < 100) break;
  }
  return issues;
}

async function githubIdentityToken() {
  const requestUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestToken = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestToken) {
    throw new Error("GitHub OIDC environment is unavailable.");
  }
  const separator = requestUrl.includes("?") ? "&" : "?";
  const response = await fetch(
    `${requestUrl}${separator}audience=wayburb-feedback-automation`,
    {headers: {Authorization: `Bearer ${requestToken}`}},
  );
  if (!response.ok) throw new Error(`GitHub OIDC ${response.status}`);
  const data = await response.json();
  if (!data.value) throw new Error("GitHub OIDC token was empty.");
  return data.value;
}

async function fetchReports() {
  const identityToken = await githubIdentityToken();
  const response = await fetch(FEEDBACK_EXPORT_URL, {
    headers: {Authorization: `Bearer ${identityToken}`},
  });
  if (!response.ok) {
    throw new Error(`Feedback export ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = await response.json();
  return Array.isArray(data.reports) ? data.reports : [];
}

function feedbackTime(value) {
  if (!value) return "Unknown";
  if (typeof value.toDate === "function") return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : date.toISOString();
}

async function main() {
  if (!process.env.GITHUB_TOKEN) throw new Error("GITHUB_TOKEN is unavailable.");
  const reports = await fetchReports();
  const issues = await listIssues();
  let created = 0;
  let duplicates = 0;
  let skipped = 0;

  for (const data of reports) {
    const exactMarker = marker(data.id);
    if (issues.some((issue) => String(issue.body || "").includes(exactMarker))) {
      skipped += 1;
      continue;
    }
    const feedback = sanitizeFeedback(data.info);
    if (!feedback) {
      skipped += 1;
      continue;
    }
    const duplicate = issues
      .map((issue) => ({issue, score: similarity(feedback, `${issue.title} ${issue.body || ""}`)}))
      .filter(({score}) => score >= 0.72)
      .sort((a, b) => b.score - a.score)[0]?.issue;
    const titleText = feedback.length > 90 ? `${feedback.slice(0, 87)}…` : feedback;
    const body = [
      feedback,
      "",
      `Platform: ${data.isApple === true ? "Apple" : "Android/other"}`,
      `Submitted: ${feedbackTime(data.time)}`,
      "",
      `<!-- ${exactMarker} -->`,
    ].join("\n");
    const newIssue = await githubRequest(`/repos/${REPOSITORY}/issues`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({title: `[Feedback] ${titleText}`, body}),
    });
    issues.push(newIssue);
    created += 1;

    if (duplicate) {
      await githubRequest(`/repos/${REPOSITORY}/issues/${newIssue.number}/comments`, {
        method: "POST",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({body: `Closing as a duplicate of #${duplicate.number}.`}),
      });
      await githubRequest(`/repos/${REPOSITORY}/issues/${newIssue.number}`, {
        method: "PATCH",
        headers: {"Content-Type": "application/json"},
        body: JSON.stringify({state: "closed", state_reason: "not_planned"}),
      });
      duplicates += 1;
    }
  }
  console.log(JSON.stringify({found: reports.length, created, duplicates, skipped}));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {marker, sanitizeFeedback, similarity};
