/**
 * The dashboard, as one string.
 *
 * NO BUILD STEP AND NO CDN. It is one page read by one person; a bundler, a
 * framework and a second deployment would all be machinery for that. Inline
 * everything so the Worker can answer with it directly and there is nothing
 * else to keep alive.
 *
 * The numbers come from `/v1/admin/stats`, same origin, with an HttpOnly
 * cookie no script here can read — including any script that got onto the page
 * by accident. This file never touches a token.
 */
export const ADMIN_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>OpenTV — dashboard</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0d0d0f; color:#e9e9ee;
         font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  /*
   * 1500, not 900. The people table used to be seven columns and fitted; it is
   * eleven now, and every one of them is a fact you read across a single row —
   * who they are, whether they are Plus, when they last opened it. A narrow
   * column that scrolls sideways turns "read a row" into "read half a row and
   * drag". Capped rather than full width so the stat cards above do not stretch
   * into a line of numbers a metre apart on a big screen.
   */
  .wrap { max-width: 1500px; margin: 0 auto; padding: 40px 20px 80px; }
  h1 { font-size:20px; margin:0 0 4px; color:#ffd400; letter-spacing:.02em; }
  .sub { color:#8a8a92; font-size:13px; margin:0 0 28px; }
  /* An explicit display beats the hidden attribute's display:none, so the
     sign-in form stayed on screen after signing in. Anything hidden is hidden. */
  [hidden] { display:none !important; }
  form { max-width:340px; display:flex; flex-direction:column; gap:10px; }
  input { background:#16161a; border:1px solid #26262b; border-radius:10px;
          padding:12px 14px; color:#e9e9ee; font-size:15px; }
  button { background:#ffd400; color:#000; border:0; border-radius:999px;
           padding:12px 18px; font-weight:800; font-size:15px; cursor:pointer; }
  button.ghost { background:#16161a; color:#8a8a92; font-weight:600; }
  .err { color:#e5484d; font-size:13px; min-height:18px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .card { background:#16161a; border-radius:12px; padding:14px 16px; }
  .card .n { font-size:26px; font-weight:800; letter-spacing:-.02em; }
  .card .k { color:#8a8a92; font-size:12px; text-transform:uppercase;
             letter-spacing:.05em; margin-top:2px; }
  .card.warn .n { color:#ffd400; }
  .card.bad .n { color:#e5484d; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.06em;
       color:#8a8a92; margin:30px 0 10px; font-weight:700; }
  /* A heading that needs a sentence gets one, rather than leaving the reader to
     work out why two sections counting "comments" disagree. */
  .note { color:#6b6b72; font-size:12px; margin:-4px 0 10px; line-height:1.5; }
  .bars { display:flex; align-items:flex-end; gap:6px; height:110px;
          background:#16161a; border-radius:12px; padding:14px; }
  .bar { flex:1; background:#26262b; border-radius:4px 4px 0 0; position:relative;
         min-height:2px; }
  .bar.on { background:#ffd400; }
  .bar span { position:absolute; bottom:-20px; left:0; right:0; text-align:center;
              font-size:10px; color:#6b6b72; }
  /* TRENDS: four charts, each with its own numbers, so a bar can be read
     without hovering. The last bar is today so far, drawn lighter. */
  .trends { display:grid; grid-template-columns:repeat(auto-fit, minmax(420px, 1fr)); gap:12px; }
  .trend { background:#16161a; border-radius:12px; padding:14px 14px 10px; }
  .trend h3 { margin:0; font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:#8a8a92; }
  .tsum { display:flex; flex-wrap:wrap; align-items:baseline; gap:6px 14px; margin:6px 0 10px; }
  .tsum .big { font-size:26px; font-weight:800; color:#e9e9ee; }
  .tsum .lbl { font-size:12px; color:#8a8a92; }
  .up { color:#78be3d; font-weight:700; font-size:13px; }
  .down { color:#e5484d; font-weight:700; font-size:13px; }
  .flat { color:#8a8a92; font-weight:700; font-size:13px; }
  .tbars { display:flex; align-items:flex-end; gap:3px; height:120px; position:relative;
           border-bottom:1px solid #26262b; }
  .tbar { flex:1; position:relative; display:flex; flex-direction:column; justify-content:flex-end;
          align-items:center; height:100%; min-width:0; }
  .tbar:hover i { background:#fff; }
  #ttip { position:fixed; z-index:50; pointer-events:none; background:#0b0b0d; border:1px solid #33333a;
          border-radius:10px; padding:8px 11px; font-size:12px; color:#c9c9d0; line-height:1.5;
          box-shadow:0 6px 24px #0008; display:none; max-width:260px; }
  #ttip b { color:#fff; font-size:14px; }
  #ttip .d { color:#8a8a92; }
  .tbar i { display:block; width:100%; background:#ffd400; border-radius:3px 3px 0 0; min-height:1px; }
  .tbar.zero i { background:#26262b; }
  .tbar.today i { background:#ffd40080; }
  .tbar b { font-size:10px; color:#c9c9cf; font-weight:600; margin-bottom:2px; white-space:nowrap; }
  .tavg { position:absolute; left:0; right:0; border-top:1px dashed #6b6b72; pointer-events:none; }
  .tlabs { display:flex; gap:3px; margin-top:4px; }
  .tlabs span { flex:1; text-align:center; font-size:9px; color:#6b6b72; min-width:0; overflow:hidden; }
  .tfoot { font-size:11px; color:#6b6b72; margin-top:6px; }
  .row { display:flex; justify-content:space-between; align-items:center; gap:12px; }
  .acts { display:flex; gap:8px; }
  .foot { color:#6b6b72; font-size:12px; margin-top:34px; }
  table { width:100%; border-collapse:collapse; background:#16161a; border-radius:12px;
          overflow:hidden; font-size:14px; }
  th { text-align:left; color:#8a8a92; font-size:11px; text-transform:uppercase;
       letter-spacing:.05em; padding:10px 12px; background:#1b1b1f; font-weight:700; }
  td { padding:10px 12px; border-top:1px solid #202024; white-space:nowrap; }
  td.num { text-align:right; color:#a7a7ae; }
  .who { color:#e9e9ee; font-weight:700; }
  .name { color:#8a8a92; font-weight:400; }
  .tag { display:inline-block; font-size:11px; padding:1px 7px; border-radius:999px;
         background:#26262b; color:#a7a7ae; }
  .tag.warn { background:#3a3213; color:#ffd400; }
  /* PAID and GIVEN look different on purpose. One is revenue and one is a
     favour, and a single green tick would hide which is which. */
  .tag.paid { background:#13341c; color:#78be3d; }
  .tag.gift { background:#1b2540; color:#7ea6ff; }
  .tag.gone { background:#2a1416; color:#e5484d; }
  .tag.act { background:#3a3213; color:#ffd400; }
  .ev { white-space:nowrap; line-height:1.5; }
  /* A link, not a button: it reveals what is already on the row rather than
     doing anything, and the row is dense enough without another control. */
  .more { background:none; border:0; padding:0; font:inherit; color:#2e65f2; cursor:pointer; }
  .more:hover { text-decoration:underline; }
  dialog#evdlg { background:#141416; color:#fff; border:1px solid #26262b; border-radius:12px;
    padding:18px 20px; max-width:min(560px,92vw); max-height:80vh; overflow:auto; font:inherit; }
  dialog#evdlg::backdrop { background:rgba(0,0,0,.6); }
  dialog#evdlg h3 { margin:0 0 12px; font-size:15px; }
  dialog#evdlg .ev { white-space:normal; }
  dialog#evdlg .close { margin-top:14px; font:inherit; font-size:12px; padding:5px 12px;
    background:#1c1c1e; color:#fff; border:1px solid #2e2e34; border-radius:7px; cursor:pointer; }
  .vb { color:#6b6b72; }
  .plusbox { display:flex; gap:5px; align-items:center; }
  .plusbox select, .plusbox button { font:inherit; font-size:12px; padding:2px 6px;
      border-radius:6px; border:1px solid #34343a; background:#1c1c1f; color:#e9e9ee; }
  .plusbox button { cursor:pointer; }
  .plusbox button:disabled { opacity:.5; cursor:default; }
  .scroll { overflow-x:auto; }
  .note { color:#6b6b72; font-size:12px; margin:0 0 10px; }
  .shots { display:grid; grid-template-columns:repeat(auto-fill,minmax(210px,1fr)); gap:12px; }
  .shot { background:#16161a; border-radius:12px; overflow:hidden; display:flex; flex-direction:column; }
  /* Contained, never cropped: a decision about a picture has to be made about
     all of it. Checkerboard so transparent PNGs are not judged on a dark void. */
  .shot img { width:100%; height:190px; object-fit:contain; background:
      repeating-conic-gradient(#1b1b1f 0% 25%, #141417 0% 50%) 50%/16px 16px; }
  .shot .meta { padding:9px 11px; font-size:12px; color:#8a8a92; flex:1; }
  .shot .who { color:#e9e9ee; font-weight:700; font-size:12.5px; }
  .shot .cap { color:#a7a7ae; margin-top:4px; word-break:break-word; }
  .shot .btns { display:flex; gap:6px; padding:0 11px 11px; }
  .shot button { flex:1; padding:8px 0; font-size:12.5px; border-radius:8px; }
  .shot .no { background:#2a1618; color:#e5484d; font-weight:700; }
  .tabs { display:flex; gap:6px; margin-bottom:12px; }
  .tab { background:#16161a; color:#8a8a92; font-weight:600; font-size:13px;
         padding:7px 14px; border-radius:999px; }
  .tab.on { background:#26262b; color:#e9e9ee; }
  .daynav { margin-left:auto; display:flex; align-items:center; gap:6px; }
  .daynav #dlabel { color:#e9e9ee; font-weight:600; font-size:13px; min-width:92px; text-align:center; }
  .daynav .tab:disabled { opacity:.35; cursor:default; }
  .chips { display:flex; flex-wrap:wrap; gap:8px; margin:0 0 12px; }
  .chip { font:inherit; font-size:12.5px; font-weight:600; color:#a7a7ae; background:#16161a;
    border:1px solid #2a2a30; border-radius:999px; padding:6px 12px; cursor:pointer; }
  .chip .n { color:#6b6b72; margin-left:6px; font-weight:500; }
  .chip.on { color:#111; background:#ffd400; border-color:#ffd400; }
  .chip.on .n { color:#4a3f00; }
  .chip.clear { background:transparent; border-style:dashed; }
  .chip:focus-visible { outline:2px solid #ffd400; outline-offset:2px; }
  .shown { color:#8a8a92; font-size:12.5px; margin:-4px 0 10px; }
  /* Doing is the accent; opening is not. */
  .did { color:#FFD400; font-weight:600; }
  /* The linked variant, where nobody has sent a name — underlined so it is
     visibly clickable, same colour so the row still reads as one thing. */
  a.did { text-decoration:underline; text-underline-offset:2px; }
  .bulkbar { margin-top:14px; }
  .bulkbar button { width:auto; }
  /* Messages: one row per person, newest first; a dot when unread. */
  .thread { display:flex; gap:12px; align-items:baseline; padding:10px 12px; border:1px solid #26262b;
    border-radius:10px; margin-bottom:8px; cursor:pointer; background:#141416; }
  .thread:hover { border-color:#3a3a42; }
  .thread .who { font-weight:700; white-space:nowrap; }
  .thread .last { color:#a7a7ae; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
  .thread .unread { background:#ffd400; color:#000; border-radius:9px; padding:0 7px; font-size:12px; font-weight:800; }
  dialog#chatdlg { background:#141416; color:#fff; border:1px solid #26262b; border-radius:12px;
    padding:18px 20px; width:min(560px,92vw); max-height:84vh; font:inherit; }
  dialog#chatdlg::backdrop { background:rgba(0,0,0,.6); }
  dialog#chatdlg h3 { margin:0 0 12px; font-size:15px; }
  #chatb { max-height:50vh; overflow:auto; display:flex; flex-direction:column; gap:8px; margin-bottom:12px; }
  .msg { padding:8px 11px; border-radius:10px; max-width:80%; white-space:pre-wrap; word-break:break-word; }
  .msg.them { background:#1c1c1e; align-self:flex-start; }
  .msg.me { background:#ffd400; color:#000; align-self:flex-end; }
  .msg small { display:block; opacity:.6; font-size:11px; margin-top:3px; }
  .tick { font-weight:800; letter-spacing:-2px; margin-left:6px; opacity:1; }
  .tick.read { color:#1d4ed8; }
  .tick.fail { color:#b91c1c; letter-spacing:0; font-weight:700; }
  #chatin { width:100%; box-sizing:border-box; min-height:70px; background:#0b0b0d; color:#fff; border:1px solid #2e2e34;
    border-radius:8px; padding:8px; font:inherit; }
  .chatbtns { display:flex; gap:8px; justify-content:flex-end; margin-top:8px; }
  .chatbtns button { font:inherit; font-size:13px; padding:6px 14px; border-radius:7px; cursor:pointer; border:1px solid #2e2e34; background:#1c1c1e; color:#fff; }
  .chatbtns #chatsend { background:#ffd400; color:#000; border-color:#ffd400; font-weight:700; }
  /* Profile templates: the same card as a photo, dimmed when hidden. */
  .shot.off img { opacity:.35; }
  .sw { display:inline-block; width:12px; height:12px; border-radius:6px; vertical-align:-2px; margin-right:3px;
        border:1px solid #0d0d0f; }
  details.tplnew { margin-top:14px; }
  details.tplnew summary { cursor:pointer; color:#ffd400; font-weight:700; }
  .tplform { max-width:520px; margin-top:12px; }
  .tplform label { color:#8a8a92; font-size:13px; display:flex; align-items:center; gap:8px; }
  .tplrow { display:flex; gap:18px; flex-wrap:wrap; }
  .tplform select, .tplform textarea { font:inherit; background:#16161a; border:1px solid #26262b;
        border-radius:10px; padding:10px 12px; color:#e9e9ee; }
  .tplform textarea { font-family:ui-monospace,Menlo,monospace; font-size:13px; line-height:1.4; }
  .tplform .note { margin:0; }
</style>
</head>
<body>
<div class="wrap">
  <div class="row">
    <div>
      <h1>OpenTV</h1>
      <p class="sub" id="sub">Community dashboard</p>
    </div>
    <div class="acts">
      <button class="ghost" id="refresh" hidden>Refresh</button>
      <!-- Refresh may answer from the ten-minute copy; this one never does. -->
      <button class="ghost" id="hard" hidden title="Read everything from the database now">Hard refresh</button>
      <!-- Every phone at once, no app update: off means no CommsUni comments anywhere. -->
      <button class="ghost" id="commsuni" hidden title="Show CommsUni comments in the app">CommsUni: …</button>
      <select class="ghost" id="event" hidden title="Seasonal decorations and themes in the app"></select>
      <button class="ghost" id="out" hidden>Sign out</button>
    </div>
  </div>

  <form id="login">
    <input id="email" type="email" placeholder="Email" autocomplete="username" required />
    <input id="password" type="password" placeholder="Password" autocomplete="current-password" required />
    <button type="submit">Sign in</button>
    <div class="err" id="err"></div>
  </form>

  <div id="panel" hidden>
    <!-- MESSAGES FIRST: a person who wrote is waiting; everything else is counts. -->
    <h2>Messages <span id="msgcount"></span></h2>
    <div id="threads"><p class="note">Nobody has written yet.</p></div>
    <dialog id="chatdlg"><h3 id="chatt"></h3><div id="chatb"></div>
      <textarea id="chatin" placeholder="Reply — it reaches them as a notification"></textarea>
      <div class="chatbtns"><button onclick="document.getElementById('chatdlg').close()">Close</button><button id="chatsend">Send</button></div></dialog>
    <h2>People</h2>
    <p class="note">"Today" here means since 03:00 Iraq time (midnight UTC). Every time on this page is shown in Iraq time.</p>
    <div class="grid" id="people"></div>
    <h2>Trends</h2>
    <p class="note">Each day runs 03:00 → 03:00 Iraq time (midnight UTC, so every member counts on the same clock). The lighter last bar is today so far. The dashed line is the daily average; the arrow compares with the period before.</p>
    <div class="tabs" id="trendtabs">
      <button class="tab" data-days="14">14 days</button>
      <button class="tab on" data-days="30">30 days</button>
      <button class="tab" data-days="90">90 days</button>
    </div>
    <div class="trends" id="trends"><p class="note">Loading…</p></div>
    <h2>Activity</h2>
    <p class="note">Everything the community holds, imports included. These only grow.</p>
    <div class="grid" id="activity"></div>
    <h2>Activity by window &mdash; how much</h2>
    <p class="note">Written in the app, in the window shown. A seeded TV&nbsp;Time archive
       keeps its original dates and is never counted here &mdash; which is why these can read
       zero while the totals above are in the thousands.</p>
    <div class="grid" id="windows"></div>
    <h2>Activity by window &mdash; how many people</h2>
    <p class="note">The same windows, counted as people rather than rows. One member
       seeding an archive cannot move these.</p>
    <div class="grid" id="active"></div>
    <h2>People, newest first</h2>
    <!-- OPENED IS NOT USED. The list answered "who exists" and never "who is
         still here". Two buttons, not three: whether somebody DID anything is a
         tag on their name, so it reads down the column without hiding the rest
         of the list behind a filter. -->
    <!-- FILTERS, NOT TABS: each button is on or off, several at once, and a
         person must match every one that is on. Drawn in the browser from the
         list already loaded — never another request. -->
    <div class="chips" id="chips"></div>
    <div class="shown" id="shown"></div>
    <div class="tabs" id="whotabs">
      <!-- Steps the Opened filter and the day column back one day at a time. -->
      <span class="daynav">
        <button class="tab" id="dprev" title="Previous day">&lsaquo;</button>
        <span id="dlabel" title="Days run 03:00 → 03:00 Iraq time">Today</span>
        <button class="tab" id="dnext" title="Next day" disabled>&rsaquo;</button>
      </span>
    </div>
    <div class="scroll"><table id="users"></table></div>
    <!-- One dialog for the whole table: the rows are rebuilt on every refresh,
         so a dialog per row would be thrown away with them. -->
    <dialog id="evdlg"><h3 id="evdlgt"></h3><div id="evdlgb"></div>
      <button class="close" onclick="document.getElementById('evdlg').close()">Close</button></dialog>
    <h2>Photos</h2>
    <div class="tabs" id="tabs">
      <button class="tab on" data-status="pending">Waiting</button>
      <button class="tab" data-status="clean">Shown</button>
      <button class="tab" data-status="blocked">Blocked</button>
    </div>
    <p class="note" id="revnote"></p>
    <div class="shots" id="review"></div>
    <div class="bulkbar" id="bulkbar" hidden>
      <button class="ghost" id="showall">Show all on this page</button>
    </div>
    <h2>Profile templates</h2>
    <p class="note">On top of the twelve built into the app. Members' phones get these with the
       event, within 5 minutes; one tied to an event is sent only while that event is on. Hidden
       ones stay here and reach nobody. No edit &mdash; delete and save another.</p>
    <div class="shots" id="tpllist"><p class="note">None yet.</p></div>
    <details class="tplnew"><summary>New template</summary>
      <form id="tplform" class="tplform">
        <input id="tplname" placeholder="Name, e.g. Ramadan Nights" maxlength="40" required />
        <label>Banner <input id="tplimg" type="file" accept="image/jpeg,image/png,image/webp" required /></label>
        <div class="tplrow">
          <label>Colour <input id="tplc1" type="color" value="#8b5cf6" /></label>
          <label>Second colour <input id="tplc2" type="color" value="#22d3ee" /></label>
        </div>
        <select id="tpllayout"></select>
        <select id="tplpersona"></select>
        <select id="tplevent"></select>
        <textarea id="tplblocks" rows="13" spellcheck="false"></textarea>
        <p class="note">One block a line, in order. <b>a + b</b> puts two small blocks side by side;
           <b>name:2x1</b> picks a size (1x1, 2x1, 2x2). The first line is banners. Blocks: banners, intro,
           counts, stats, activity, timeline, lists, extra, since, character, streak, genre, thisYear, binge,
           finished, rated, emotions, emotionCalendar, topRated, nowWatching, shelf:shows, shelf:fav-shows,
           shelf:movies, shelf:fav-movies.</p>
        <button type="submit">Save template</button>
        <div class="err" id="tplerr"></div>
      </form>
    </details>
    <p class="foot" id="foot"></p>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);

// Times land here as UTC and are read in Baghdad. Showing the date alone hid
// which ones happened in the same hour as each other, which is the whole
// question when you are watching people arrive after a post.
function baghdad(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return String(iso ?? '');
  return d.toLocaleString('en-GB', {
    timeZone: 'Asia/Baghdad',
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/**
 * WHAT KIND OF PLUS, and until when.
 *
 * is_plus is a subscription the webhook wrote. plus_until in the future is
 * something given by hand. They are shown differently because they mean
 * different things: one is revenue and might churn, the other is a favour and
 * expires on a date nobody is charged on.
 *
 * A PAST plus_until is shown too, greyed. "Had a month, it ran out" is the
 * thing you want to see before deciding whether to give another.
 */
function plusCell(u) {
  const until = u.plus_until ? new Date(u.plus_until) : null;
  const live = until && !isNaN(until) && until.getTime() > Date.now();
  // THE PHONE SAYS PAID, THE SERVER DOES NOT. What cost a subscriber their
  // Cloud Backup and Sync on 3 Oct, with every column reading "no". The phone's
  // word grants nothing; it is here so the disagreement is seen.
  const mismatch = u.device_plus === 1 && !u.is_plus && !live
    ? '<div class="tag gone" title="Apple or Google says this account is subscribed; the server does not">&#9888; paid on phone, not on server</div>'
    : '';
  if (u.is_plus) {
    return '<span class="tag paid">paying</span>' +
      (u.plus_since ? '<div class="name">since ' + baghdad(u.plus_since) + '</div>' : '');
  }
  if (live) {
    const days = Math.ceil((until.getTime() - Date.now()) / 86400000);
    return '<span class="tag gift">given</span>' +
      '<div class="name">ends ' + baghdad(u.plus_until) + ' (' + days + 'd)</div>';
  }
  if (until && !isNaN(until)) {
    return '<span class="tag gone">expired</span><div class="name">' + baghdad(u.plus_until) + '</div>' + mismatch;
  }
  return '<span class="tag">no</span>' + mismatch;
}

/** Never "3 hours ago" with no date under it: a relative age answers "are they
 *  still here", the date answers "when exactly", and both get asked. */
/**
 * WHAT TODAY PRODUCED, beside when they last opened it.
 *
 * "3h ago" says the app launched. It does not say whether the person rated an
 * episode, voted a character or wrote a sentence, and those are the only events
 * that make this a community rather than a list of installs. Opening and doing
 * are drawn differently on purpose: a launch with nothing after it is dim, and
 * anything at all is the accent.
 *
 * Imports are already excluded upstream, so a seeded archive never appears here
 * as a busy afternoon.
 */
function todayCell(u) {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const everything = u.today || [];
  // TITLES NEWLY ON THEIR PUBLIC SHELF (shelf_seen): named, unless it is a
  // whole library arriving at once — a first sync or an import — which is one
  // line, not a hundred.
  const added = everything.filter((r) => r.kind === 'added');
  // A rating row with no score is a feeling picked without stars — the
  // "felt" line already says it, and "rated … /10" with no number misled.
  const rows = everything.filter((r) => r.kind !== 'added' && !(r.kind === 'rating' && (r.detail == null || r.detail === '')));
  // Library work (shows added, episodes marked) is not an event this server
  // keeps — only that the phone republished its totals on this day.
  // WHAT CHANGED, not the whole library: the totals minus where the day
  // started (profile_stats.day_base_*). On the joining day there is no start,
  // so it says what they arrived with. A sync that moved neither count was a
  // favourite, a list or Plus changing.
  const joinedThatDay = typeof u.created_at === 'string' && typeof u.library_at === 'string' && u.created_at.slice(0, 10) === u.library_at.slice(0, 10);
  const signed = (d, one, many) => (d > 0 ? '+' : '') + d + ' ' + (Math.abs(d) === 1 ? one : many);
  let libraryVerb = '';
  let libraryText = '';
  if (u.library_on_day) {
    if (joinedThatDay || u.day_base_episodes == null) {
      // Not Plus Sync: the phone republished its profile totals and there is no
      // start-of-day count to subtract, so this is the whole library.
      libraryVerb = joinedThatDay ? 'joined with' : 'library now';
      libraryText = esc(u.episodes_watched ?? 0) + ' episodes &middot; ' + esc(u.movies_watched ?? 0) + ' films';
    } else {
      const de = (u.episodes_watched ?? 0) - u.day_base_episodes;
      const dm = (u.movies_watched ?? 0) - (u.day_base_movies ?? u.movies_watched ?? 0);
      const parts = [];
      if (de !== 0) parts.push(signed(de, 'episode', 'episodes'));
      if (dm !== 0) parts.push(signed(dm, 'film', 'films'));
      libraryVerb = parts.length ? 'library' : 'changed';
      libraryText = parts.length ? parts.join(' &middot; ') : 'favourites, lists or Plus';
    }
  }
  const libraryLine = libraryVerb
    ? '<div class="ev"><span class="vb">' + libraryVerb + '</span> <span class="did">' + libraryText + '</span></div>'
    : '';
  const shelfLines = !added.length ? ''
    : added.length > 15 || joinedThatDay
      ? '<div class="ev"><span class="vb">added</span> <span class="did">' + added.length + ' titles</span><span class="name"> to their shelves</span></div>'
      : added.map((r) => '<div class="ev"><span class="vb">added</span> <span class="did">' + esc(r.title) +
          '</span><span class="name"> &middot; ' + (r.detail === 'movie' ? 'film' : 'show') + '</span></div>').join('');
  // AN ACCOUNT ONLY publishes nothing, but its changes still go through Sync —
  // counted, never named.
  const syncLine = !u.joined_at && u.sync_today
    ? '<div class="ev"><span class="vb">synced</span> <span class="did">' + esc(u.sync_today) + (u.sync_today === 1 ? ' change' : ' changes') + '</span></div>'
    : '';
  const library = libraryLine + shelfLines + syncLine;
  if (!rows.length) {
    if (library) return library;
    return openedToday(u) ? '<span class="name">opened only</span>' : '<span class="name">&mdash;</span>';
  }
  // The verb first, because the kind of thing they did is what is being scanned
  // for; the title carries the accent because it is what the eye stops on.
  const verb = { comment: 'wrote on', rating: 'rated', character: 'voted', emotion: 'felt', added: 'added' };
  const one = (r) => {
    const detail = r.kind === 'rating' ? ' ' + esc(r.detail) + '/10'
      : r.kind === 'character' || r.kind === 'emotion' ? ' &middot; ' + esc(r.detail)
      : '';
    // An unnamed TheTVDB id is a link rather than a dead number: nobody has
    // sent this server a name for it, and one click beats copying it out.
    const what = esc(r.title) + (r.where ? ' ' + esc(r.where) : '');
    const did = r.tvdbId
      ? '<a class="did" target="_blank" rel="noopener" href="https://thetvdb.com/dereferrer/series/' +
        esc(r.tvdbId) + '">' + what + '</a>'
      : '<span class="did">' + what + '</span>';
    return '<div class="ev"><span class="vb">' + (verb[r.kind] || r.kind) + '</span> ' + did +
      '<span class="name">' + detail + '</span></div>';
  };
  const all = library + rows.map(one).join('');
  if (rows.length <= 4) return all;
  // The full list travels with the row rather than being fetched again: it is
  // already here, and the dashboard refreshes often enough that a second
  // request would race the rebuild.
  return library + rows.slice(0, 4).map(one).join('') +
    '<button class="more" data-more="' + esc(u.handle || '') + '">+' + (rows.length - 4) + ' more</button>' +
    '<div class="allev" hidden>' + all + '</div>';
}

/**
 * "+12 more" opens the rest, rather than being a fact nobody can act on.
 *
 * Delegated on the table for the same reason wirePlus is: these rows are
 * replaced wholesale on every refresh, so a listener bound per button would be
 * re-attached each time or lost with the row it was on.
 */
function wireMore() {
  $('users').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-more]');
    if (!btn) return;
    const cell = btn.closest('td');
    const all = cell && cell.querySelector('.allev');
    if (!all) return;
    $('evdlgt').textContent = dayName(viewDay || serverToday) + ' — @' + btn.getAttribute('data-more');
    $('evdlgb').innerHTML = all.innerHTML;
    $('evdlg').showModal();
  });
}

/**
 * Did the app speak to the server today — the SERVER'S today.
 *
 * This used to work out midnight from the browser's clock, which is three hours
 * away from UTC here, so for three hours every night the cards above counted one
 * day and this table filtered another. The route decides now and sends the
 * answer; the page only reads it.
 */
function openedToday(u) {
  return !!u.opened_today;
}

/** Anything at all today, whatever kind. */
function didToday(u) {
  return !!(u.today && u.today.length);
}

/**
 * Cloud backup to OpenTV and sync between devices: when each last happened.
 * "on" is a sync within 30 days — a phone with sync on pushes whenever
 * something changes. Backups also show their size, which says a real library
 * went up rather than an empty one.
 */
function backupSyncCell(u) {
  const short = (iso) => {
    const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
    return mins < 60 ? mins + 'm ago' : mins < 1440 ? Math.round(mins / 60) + 'h ago' : Math.round(mins / 1440) + 'd ago';
  };
  const mb = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
  const backup = u.backup_at
    ? '<div><span class="tag paid">backup</span> ' + short(u.backup_at) + (u.backup_bytes ? ' &middot; ' + mb(u.backup_bytes) : '') + '</div>'
    : '<div><span class="tag">backup</span> <span class="name">never</span></div>';
  const syncOn = u.sync_at && Date.now() - Date.parse(u.sync_at) < 30 * 86400000;
  const sync = u.sync_at
    ? '<div><span class="tag ' + (syncOn ? 'paid' : 'gone') + '">sync ' + (syncOn ? 'on' : 'idle') + '</span> ' + short(u.sync_at) + '</div>'
    : '<div><span class="tag">sync</span> <span class="name">never</span></div>';
  return backup + sync;
}

function seenCell(iso) {
  if (!iso) return '<span class="name">never</span>';
  const t = Date.parse(iso);
  if (!isFinite(t)) return '<span class="name">' + baghdad(iso) + '</span>';
  const mins = Math.round((Date.now() - t) / 60000);
  const ago = mins < 60 ? mins + 'm ago'
    : mins < 1440 ? Math.round(mins / 60) + 'h ago'
    : Math.round(mins / 1440) + 'd ago';
  return ago + '<div class="name">' + baghdad(iso) + '</div>';
}

/** Months, then Give. 0 is in the list because removing a grant is the same
 *  action as setting one — the whole feature is a single date. */
function grantCell(handle) {
  const opts = [1, 2, 3, 4, 5, 6, 12, 0].map((m) =>
    '<option value="' + m + '">' + (m === 0 ? 'remove' : m === 12 ? '1 year' : m + ' month' + (m > 1 ? 's' : '')) + '</option>',
  ).join('');
  return '<div class="plusbox"><select data-h="' + handle + '">' + opts + '</select>' +
    '<button data-give="' + handle + '">Give</button></div>';
}

/**
 * Wired once on the table rather than per button: the rows are rebuilt on every
 * refresh, and a listener per row would be re-attached each time or lost.
 */
/** A message from OpenTV to one person, in their bell. One way — no replies. */
function wireMessage() {
  $('users').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-msg]');
    if (!btn) return;
    const handle = btn.getAttribute('data-msg');
    const text = prompt('Message to @' + handle + ' (shows in their notifications, max 500 characters). Sign it — Noddy.');
    if (text == null || !text.trim()) return;
    if (text.trim().length > 500) { alert('That is over 500 characters.'); return; }
    // WHERE A TAP OPENS — the same closed list the app keeps (MESSAGE_ROUTES).
    const routes = [null, '/cloud-backup', '/paywall', '/join', '/settings', '/sign-in?next=/cloud-backup'];
    const pick = prompt('When they tap it, open:\\n0  nothing (the notifications list)\\n1  Cloud Backup\\n2  Plus\\n3  Join the community\\n4  Settings\\n5  Sign in, then Cloud Backup', '0');
    if (pick == null) return;
    const route = routes[Number(pick)] ?? null;
    btn.disabled = true;
    try {
      const res = await fetch('/v1/admin/users/' + encodeURIComponent(handle) + '/message', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim(), route }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error?.message || 'failed');
      btn.textContent = out.devices > 0 ? 'Sent ✓' : 'Saved — no phone';
      if (!out.devices) alert('Saved, but this person never allowed notifications, so no phone will ring.');
    } catch (err) {
      alert('Not sent: ' + err.message);
      btn.disabled = false;
    }
  });
}

function wirePlus() {
  $('users').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-give]');
    if (!btn) return;
    const handle = btn.getAttribute('data-give');
    const sel = $('users').querySelector('select[data-h="' + CSS.escape(handle) + '"]');
    const months = Number(sel.value);
    const label = months === 0 ? 'Remove Plus from @' + handle + '?'
      : 'Give @' + handle + ' ' + (months === 12 ? '1 year' : months + ' month(s)') + ' of Plus?';
    if (!confirm(label)) return;
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const res = await fetch('/v1/admin/users/' + encodeURIComponent(handle) + '/plus', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ months }),
      });
      const out = await res.json();
      if (!res.ok) throw new Error(out.error?.message || 'failed');
      // A paying subscriber's time went to the store, not plus_until.
      if (out.via) alert('Extended at ' + (out.via === 'app_store' ? 'Apple' : 'Google Play') + '. Renews ' + (out.plus_expires_at ? baghdad(out.plus_expires_at) : 'later') + '.');
      await load();
    } catch (err) {
      alert(String(err.message || err));
      btn.disabled = false;
      btn.textContent = 'Give';
    }
  });
}

function cards(el, items) {
  el.innerHTML = items.map(([k, n, cls]) =>
    '<div class="card ' + (cls || '') + '"><div class="n">' + (n ?? 0).toLocaleString() +
    '</div><div class="k">' + k + '</div></div>').join('');
}

async function load() {
  const res = await fetch('/v1/admin/stats', { credentials: 'same-origin' });
  if (res.status === 401) { show(false); return; }
  const d = await res.json();
  const t = d.totals || {};
  show(true);

  cards($('people'), [
    ['Accounts', t.accounts],
    // Google's pre-launch test phones sign in on every Play upload. Shown so
    // they are visible, and left out of Accounts and the Opened counts.
    ['Test robots', t.robots],
    // ACTIVE MEMBERS, never "active users". Only members reach this server, so
    // this is the whole of what can honestly be counted — and the people it
    // leaves out are the ones the app promises never to contact.
    ['Opened today', t.active_today],
    ['Last 7 days', t.active_7d],
    ['Last 30 days', t.active_30d],
    // Two cards, never one. See the note on the query: adding a hand-out to a
    // subscription makes the business look like something it is not.
    ['Plus paying', t.plus_paying],
    ['Plus given', t.plus_given],
    ['With Apple', t.via_apple],
    ['With Google', t.via_google],
    ['With email', t.via_email],
    // Both of these mean somebody is stuck rather than something is popular.
    ['Unconfirmed', t.unconfirmed, t.unconfirmed ? 'warn' : ''],
    ['No username yet', t.placeholder_handles, t.placeholder_handles ? 'warn' : ''],
    ['Deleted', t.deleted],
    ['Push devices', t.push_devices],
  ]);

  cards($('activity'), [
    ['Comments', t.comments],
    ['Ratings', t.ratings],
    ['Character votes', t.character_votes],
    ['Emotion votes', t.emotion_votes],
    ['Likes', t.likes],
    ['Follows', t.follows],
    ['Lists', t.lists],
    // THE LIST REPAIR. Films is the number that matters: a call that resolves
    // nothing still counts as a call, so calls alone would look like success.
    ['List fixes asked', t.repair_calls],
    ['Films restored', t.repair_films],
    ['Catalogue films', t.catalogue_films],
    ['Photos held', t.images],
    // The only queue on this page a person has to work through by hand: an
    // image is invisible to everybody until somebody here has looked at it.
    ['Photos to review', t.images_pending, t.images_pending ? 'warn' : ''],
    ['Photos shown', t.images_clean],
    // The only number with a clock on it — 24 hours is the moderation promise.
    ['Open reports', t.open_reports, t.open_reports ? 'bad' : ''],
  ]);

  /* HOW MUCH IS HAPPENING. The Activity totals above only ever grow, so they
     say what the community HOLDS and never what it DID this week. Each row is
     the same three windows the People section uses, plus the per-day average
     over thirty days — the one number that can be compared with last month. */
  const per = (n, days) => Math.round(((n || 0) / days) * 10) / 10;
  /* SAME THREE NOUNS, SAME ORDER, IN BOTH SECTIONS. They were "Comments,
     Ratings, Characters" here and "Rated, Commented, Voted" below — three
     different words in a different order for the same three things, which
     reads as two sections disagreeing rather than as rows against people. */
  cards($('windows'), [
    ['Comments today', t.comments_today],
    ['Comments, 7 days', t.comments_7d],
    ['Comments, 30 days', t.comments_30d],
    ['Comments a day', per(t.comments_30d, 30)],
    ['Ratings today', t.ratings_today],
    ['Ratings, 7 days', t.ratings_7d],
    ['Ratings, 30 days', t.ratings_30d],
    ['Ratings a day', per(t.ratings_30d, 30)],
    ['Character votes today', t.characters_today],
    ['Character votes, 7 days', t.characters_7d],
    ['Character votes, 30 days', t.characters_30d],
    ['Character votes a day', per(t.characters_30d, 30)],
  ]);

  /* THE ONLY NUMBERS HERE A SINGLE IMPORT CANNOT MOVE. One member seeding a
     TV Time archive can put three thousand ratings on the board in a day; they
     are still one person, and this is the row that says so. */
  cards($('active'), [
    ['People commenting today', t.commenters_today],
    ['People commenting, 7 days', t.commenters_7d],
    ['People commenting, 30 days', t.commenters_30d],
    ['People rating today', t.raters_today],
    ['People rating, 7 days', t.raters_7d],
    ['People rating, 30 days', t.raters_30d],
    ['People voting today', t.voters_today],
    ['People voting, 7 days', t.voters_7d],
    ['People voting, 30 days', t.voters_30d],
  ]);

  await loadTrends();

  await loadPeople();

  await loadThreads();

  await loadReview();

  await loadTemplates();

  // WAS "never what anybody wrote", and the Today column made that untrue: it
  // names the title somebody rated or voted on. Comment TEXT is still never
  // read here, and that is the line the sentence now draws.
  $('foot').textContent = 'This page reads counts, and the titles today was spent on — never the ' +
    'text of a comment. Read ' + new Date().toLocaleTimeString();
}


/* ── Trends ── */
let trendDays = 30;
const TRENDS = [
  ['joins', 'New members', 'total'],
  ['opened', 'Members who opened the app', 'avg'],
  ['comments', 'Comments written in the app', 'total'],
  ['ratings', 'Ratings given in the app', 'total'],
  ['deletes', 'Accounts deleted', 'total'],
  ['plus', 'New Plus subscribers (store)', 'total'],
  ['returned', 'New members back the next day (%)', 'pct'],
  ['method', 'How new members signed up', 'stack'],
  ['usage', 'Plus in use: backups and syncing', 'stack'],
];
// Stacked charts: each part of the bar, its row field, its colour. Email is
// what is left of a day's joins after Apple and Google.
const STACKS = {
  method: [['apple', 'Apple', '#e9e9ee'], ['google', 'Google', '#4c8bf5'], ['email', 'Email', '#ffd400']],
  usage: [['b', 'backed up', '#78be3d'], ['s', 'synced', '#ffd400']],
};
function partOf(key, row, field) {
  if (!row) return 0;
  if (key === 'method' && field === 'email') return Math.max(0, row.n - (row.apple || 0) - (row.google || 0));
  return row[field] || 0;
}
function dayList(end, n) {
  const out = [];
  const t = Date.parse(end + 'T00:00:00Z');
  for (let i = n - 1; i >= 0; i--) out.push(new Date(t - i * 86400000).toISOString().slice(0, 10));
  return out;
}
function shortDay(d) {
  const dt = new Date(d + 'T00:00:00Z');
  return ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'][dt.getUTCDay()] + ' ' + d.slice(8);
}
// worse = a line where going up is bad news (deleted accounts): red up, green down.
function changeHtml(now, before, worse) {
  const good = (up) => (up !== !!worse ? 'up' : 'down');
  if (before == null) return '<span class="flat">no earlier data</span>';
  if (before === 0) return now > 0 ? '<span class="' + good(true) + '">▲ new</span>' : '<span class="flat">–</span>';
  const pct = Math.round(((now - before) / before) * 100);
  if (pct === 0) return '<span class="flat">= same as before</span>';
  return '<span class="' + good(pct > 0) + '">' + (pct > 0 ? '▲ ' : '▼ ') + Math.abs(pct) + '% vs previous ' + trendDays + ' days</span>';
}
function drawTrend(key, title, kind, d) {
  const rows = d.series[key] || [];
  const map = {};
  rows.forEach((r) => { map[r.day] = r.n; });
  const rowOf0 = {};
  rows.forEach((r) => { rowOf0[r.day] = r; });
  const cur = dayList(d.today, d.days);
  const prev = dayList(new Date(Date.parse(cur[0] + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10), d.days);
  const vals = cur.map((day) => map[day] || 0);
  const total = vals.reduce((a, b) => a + b, 0);
  // Today is not over, so the average and the comparison use whole days only.
  const whole = vals.slice(0, -1);
  const avg = whole.length ? whole.reduce((a, b) => a + b, 0) / whole.length : 0;
  let before = prev.reduce((a, day) => a + (map[day] || 0), 0);
  const prevWhole = prev.slice(1);
  let beforeAvg = prevWhole.reduce((a, day) => a + (map[day] || 0), 0) / Math.max(1, prevWhole.length);
  // opened: kept 90 days; deletes: purged after 30, so a period before that is unknown.
  const known = key === 'opened' ? (d.openedSince && d.openedSince <= prev[0]) : key === 'deletes' ? 2 * d.days <= 30 : true;
  if (!known) { before = null; beforeAvg = null; }
  const max = Math.max(1, ...vals);
  const best = vals.indexOf(Math.max(...vals));
  const showAll = d.days <= 30;
  const every = d.days <= 14 ? 1 : d.days <= 30 ? 3 : 10;
  // pct: the days themselves are already rates, so the summary is a weighted
  // rate over the period (people back / people joined), not a sum.
  let pctNow = null, pctBefore = null;
  if (kind === 'pct') {
    const sum = (days) => days.reduce((a, day) => { const r = rowOf0[day]; if (r) { a[0] += r.d1; a[1] += r.joined; } return a; }, [0, 0]);
    const [b1, j1] = sum(cur); const [b0, j0] = sum(prev);
    pctNow = j1 ? Math.round((100 * b1) / j1) : 0; pctBefore = j0 ? Math.round((100 * b0) / j0) : null;
  }
  const big = kind === 'pct' ? pctNow + '%' : kind === 'avg' ? (Math.round(avg * 10) / 10).toLocaleString() : total.toLocaleString();
  const lbl = kind === 'pct' ? 'came back the next day' : kind === 'avg' ? 'a day on average' : 'in ' + d.days + ' days · ' + (Math.round(avg * 10) / 10) + ' a day';
  const worse = key === 'deletes';
  const change = kind === 'pct' ? (pctBefore == null ? '<span class="flat">no earlier data</span>' : changeHtml(pctNow, pctBefore, false)) : kind === 'avg' ? changeHtml(avg, beforeAvg, worse) : changeHtml(total - vals[vals.length - 1], before == null ? null : before - (map[prev[prev.length - 1]] || 0), worse);
  const rowOf = {};
  rows.forEach((r) => { rowOf[r.day] = r; });
  const bars = vals.map((n, i) => {
    const cls = 'tbar' + (n ? '' : ' zero') + (i === vals.length - 1 ? ' today' : '');
    const label = n && (showAll || i === best || i === vals.length - 1) ? '<b>' + n + (kind === 'pct' ? '%' : '') + '</b>' : '';
    const tip = tipFor(key, cur[i], n, rowOf[cur[i]], avg, i === vals.length - 1).replace(/"/g, '&quot;');
    const segs = STACKS[key] && n
      ? STACKS[key].slice().reverse().map(([f, , col]) => {
          const v = partOf(key, rowOf[cur[i]], f);
          return v ? '<i style="height:' + Math.max(1, Math.round((v / max) * 86)) + '%;background:' + col + ';border-radius:0"></i>' : '';
        }).join('')
      : '<i style="height:' + Math.max(1, Math.round((n / max) * 86)) + '%"></i>';
    return '<div class="' + cls + '" data-tip="' + tip + '">' + label + segs + '</div>';
  }).join('');
  const avgLine = avg > 0 ? '<div class="tavg" style="bottom:' + Math.round((avg / max) * 86) + '%" title="average ' + (Math.round(avg * 10) / 10) + '"></div>' : '';
  const labs = cur.map((day, i) => '<span>' + ((i % every === 0 || i === cur.length - 1) ? shortDay(day) : '') + '</span>').join('');
  const foot = (total ? 'Best day: ' + shortDay(cur[best]) + ' (' + vals[best] + ')' : 'Nothing yet in this period') + (key === 'opened' && d.openedSince ? ' · counted since ' + d.openedSince : '') + (key === 'deletes' && d.days > 30 ? ' · deleted accounts are purged after 30 days, so older days read empty' : '');
  const legend = STACKS[key] ? '<div class="tfoot">' + STACKS[key].map(([, name, col]) => '<span style="color:' + col + '">■</span> ' + name).join(' &nbsp; ') + '</div>' : '';
  const note = key === 'returned' ? '<div class="tfoot">The last two days fill in once their next day is over.</div>'
    : key === 'usage' ? '<div class="tfoot">Backups counted from 15 Oct 2026.</div>' : '';
  return '<div class="trend"><h3>' + title + '</h3>' + legend + note +
    '<div class="tsum"><span class="big">' + big + '</span><span class="lbl">' + lbl + '</span>' + change + '</div>' +
    '<div class="tbars">' + avgLine + bars + '</div><div class="tlabs">' + labs + '</div>' +
    '<div class="tfoot">' + foot + '</div></div>';
}
const TIP_UNIT = {
  joins: ['new member', 'new members'],
  opened: ['member opened the app', 'members opened the app'],
  comments: ['comment', 'comments'],
  ratings: ['rating', 'ratings'],
  deletes: ['account deleted', 'accounts deleted'],
  plus: ['new subscriber', 'new subscribers'],
  returned: ['% came back the next day', '% came back the next day'],
  method: ['new member', 'new members'],
  usage: ['person used Plus', 'people used Plus'],
};
function tipFor(key, day, n, row, avg, isToday) {
  const date = new Date(day + 'T00:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const unit = TIP_UNIT[key][n === 1 ? 0 : 1];
  let detail = '';
  if (key === 'returned' && row) {
    detail = row.d1 + ' of ' + row.joined + ' joined that day came back the next day · ' + row.d7 + ' within 7 days';
  } else if (key === 'usage' && row) {
    detail = row.b + ' backed up · ' + row.s + ' synced';
  } else if ((key === 'joins' || key === 'method') && n && row) {
    const other = n - (row.apple || 0) - (row.google || 0);
    detail = [['Apple', row.apple], ['Google', row.google], ['Email', other]].filter(([, v]) => v > 0).map(([k, v]) => v + ' ' + k).join(' · ');
  } else if ((key === 'comments' || key === 'ratings') && n && row && row.p) {
    detail = 'by ' + row.p + (row.p === 1 ? ' person' : ' people');
  }
  let vs = '';
  if (avg > 0 && !isToday) {
    const r = n / avg;
    vs = r >= 1.5 ? r.toFixed(1) + '× the ' + (Math.round(avg * 10) / 10) + ' average'
      : r <= 0.67 ? 'below the ' + (Math.round(avg * 10) / 10) + ' average' : 'about average';
  }
  return '<span class="d">' + date + (isToday ? ' · today so far' : '') + '</span><br><b>' + n + '</b> ' + unit +
    (detail ? '<br>' + detail : '') + (vs ? '<br><span class="d">' + vs + '</span>' : '');
}
const ttip = document.createElement('div');
ttip.id = 'ttip';
document.body.appendChild(ttip);
document.addEventListener('mouseover', (e) => {
  const bar = e.target.closest && e.target.closest('.tbar');
  if (!bar) { ttip.style.display = 'none'; return; }
  ttip.innerHTML = bar.dataset.tip;
  ttip.style.display = 'block';
  const r = bar.getBoundingClientRect();
  const w = ttip.offsetWidth, h = ttip.offsetHeight;
  ttip.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left + r.width / 2 - w / 2)) + 'px';
  ttip.style.top = Math.max(8, r.top - h - 8) + 'px';
});
document.addEventListener('scroll', () => { ttip.style.display = 'none'; }, true);
async function loadTrends() {
  const res = await fetch('/v1/admin/trends?days=' + trendDays, { credentials: 'same-origin' });
  if (!res.ok) { $('trends').innerHTML = '<p class="note">Trends could not be read.</p>'; return; }
  const d = await res.json();
  $('trends').innerHTML = TRENDS.map(([k, t, kind]) => drawTrend(k, t, kind, d)).join('');
}
document.querySelectorAll('#trendtabs .tab').forEach((b) => b.addEventListener('click', () => {
  trendDays = Number(b.dataset.days);
  document.querySelectorAll('#trendtabs .tab').forEach((x) => x.classList.toggle('on', x === b));
  loadTrends();
}));

/** Which UTC day the people table is showing; '' is today. */
let viewDay = '';
let serverToday = '';

function dayName(d) {
  if (!d || d === serverToday) return 'Today';
  const y = new Date(Date.parse(serverToday + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  if (d === y) return 'Yesterday';
  return new Date(d + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

async function loadPeople() {
  const q = viewDay ? '?day=' + viewDay : '';
  const people = await (await fetch('/v1/admin/users' + q, { credentials: 'same-origin' })).json();
  allPeople = people.items || [];
  serverToday = people.today || serverToday;
  const shown = people.day || serverToday;
  const name = dayName(shown);
  $('dlabel').textContent = name;
  openedLabel = 'Opened ' + (name === 'Today' || name === 'Yesterday' ? name.toLowerCase() : 'on ' + name);
  $('dnext').disabled = shown >= serverToday;
  drawPeople();
}

function stepDay(delta) {
  const base = viewDay || serverToday;
  if (!base) return;
  const d = new Date(Date.parse(base + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10);
  viewDay = d >= serverToday ? '' : d;
  void loadPeople();
}

/** The rows as fetched. The tabs filter this in the browser rather than asking
 *  the server again: 200 rows is nothing, and a refetch per tap would make the
 *  three buttons feel like page loads. */
let allPeople = [];
/**
 * The people filters. Every one is a question about a person the list already
 * answers; a person shows when they match ALL the filters that are on.
 */
let openedLabel = 'Opened today';
const FILTERS = [
  { id: 'opened', label: () => openedLabel, test: (u) => openedToday(u) },
  { id: 'did', label: () => 'Did something', test: (u) => didToday(u) || !!u.library_on_day },
  { id: 'paying', label: () => 'Paying', test: (u) => !!u.is_plus },
  { id: 'given', label: () => 'Plus given', test: (u) => !u.is_plus && !!u.plus_until && Date.parse(u.plus_until) > Date.now() },
  { id: 'expired', label: () => 'Plus expired', test: (u) => !u.is_plus && !!u.plus_until && Date.parse(u.plus_until) <= Date.now() },
  { id: 'mismatch', label: () => '\u26A0 Paid on phone', test: (u) => u.device_plus === 1 && !u.is_plus },
  // Plus is mostly paid FOR the backup, so a subscriber with none is the one
  // to write to (Cru, 8 Oct: paying five days, sync on, no copy ever landed).
  { id: 'nobackup', label: () => '\u26A0 Plus, no backup', test: (u) => (!!u.is_plus || (!!u.plus_until && Date.parse(u.plus_until) > Date.now())) && !u.backup_at },
  { id: 'backup', label: () => 'Backs up', test: (u) => !!u.backup_at },
  { id: 'sync', label: () => 'Sync on', test: (u) => !!u.sync_at && Date.now() - Date.parse(u.sync_at) < 30 * 86400000 },
  { id: 'library', label: () => 'Has a library', test: (u) => u.episodes_watched != null },
  { id: 'nolibrary', label: () => 'No library yet', test: (u) => u.episodes_watched == null },
  { id: 'nousername', label: () => 'No username', test: (u) => String(u.handle || '').startsWith('user_p_') },
  { id: 'week', label: () => 'Joined this week', test: (u) => Date.now() - Date.parse(u.created_at) < 7 * 86400000 },
  { id: 'apple', label: () => 'Apple', test: (u) => String(u.providers || '').includes('apple') },
  { id: 'google', label: () => 'Google', test: (u) => String(u.providers || '').includes('google') },
  { id: 'email', label: () => 'Email', test: (u) => !!u.email },
  { id: 'robot', label: () => 'Test robots', test: (u) => !!u.robot },
];
const activeFilters = new Set();

function drawChips() {
  $('chips').innerHTML = FILTERS.map((f) =>
    '<button class="chip' + (activeFilters.has(f.id) ? ' on' : '') + '" data-f="' + f.id + '" aria-pressed="' + activeFilters.has(f.id) + '">' +
    f.label() + '<span class="n">' + allPeople.filter(f.test).length + '</span></button>').join('') +
    (activeFilters.size ? '<button class="chip clear" data-f="__clear">Clear</button>' : '');
}

function drawPeople() {
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  /*
   * A COUNT THAT MAY NOT EXIST, said in words.
   *
   * Never published is not the same as zero: a person who opened the app once
   * and closed it may hold a decade of history on their phone, and this server
   * has simply never been told. It was an em dash, which read as a rendering
   * fault twice -- so it says what it means instead. Zero would be the one
   * genuinely wrong answer of the three.
   */
  // Null means their phone has never sent totals: no library of their own yet
  // (a new install shows a demo library, which is never sent) or not opened
  // since signing in. Nothing failed, so it should not read like a fault.
  // "imported" = the server holds TV Time ratings or comments from them, so a
  // library exists on the phone and only the totals are owed.
  const PUBLISH_WHY = {
    empty: 'no watched episodes or films on the phone',
    seed: 'phone still on the demo library',
    no_token: 'phone has lost its sign-in',
    fingerprint_failed: 'phone could not read its library',
    build_failed: 'phone could not build the shelves',
    held: 'phone holds less than the profile; waiting for the person to choose',
    check_failed: 'phone could not read the profile to compare',
    // One phone publishes a free profile (0052); this is the other one.
    other_device: 'another of their phones publishes the profile',
  };
  const num = (v, u) =>
    v != null ? String(v)
    : !u.joined_at ? '<span class="name">private (account only)</span>'
    // The phone's own reason, from 1.6.8 on (0051): one word instead of a guess.
    : u.publish_state && u.publish_state !== 'ok' ? '<span class="name">not sent: ' + (PUBLISH_WHY[u.publish_state] || u.publish_state) + '</span>'
    : u.imported_archive ? '<span class="name">imported, never sent (phone older than 1.6.8 gives no reason)</span>'
    : '<span class="name">no library yet</span>';
  const on = FILTERS.filter((f) => activeFilters.has(f.id));
  const rows = allPeople.filter((u) => on.every((f) => f.test(u)));
  drawChips();
  $('shown').textContent = on.length ? 'Showing ' + rows.length + ' of ' + allPeople.length : allPeople.length + ' people';
  $('users').innerHTML =
    '<tr><th>Handle</th><th>Plus</th><th>Give Plus</th><th>Last opened</th><th>Backup / Sync</th><th>' + esc(dayName(viewDay || serverToday)) + '</th>' +
    '<th>Signs in with</th><th>Joined</th><th class="num">Comments</th>' +
    '<th class="num">Ratings</th><th class="num">Feelings</th><th class="num">Characters</th>' +
    '<th class="num">Photos</th><th class="num">Lists</th>' +
    // A LIFETIME TOTAL, NOT AN EVENT. There is no watch history on this server,
    // so nothing here can say what somebody watched today. What a phone sends
    // when it publishes a profile is how many -- which is real, and was sitting
    // unread in profile_stats. Em dash where a profile has never published:
    // that is the truth about it, where 0 would be a claim.
    '<th class="num">Episodes</th><th class="num">Films</th>' +
    '<th class="num">Followers</th></tr>' +
    rows.map((u) => {
      const placeholder = String(u.handle).startsWith('user_p_');
      // THE SAME SHAPE AS THE PLUS TAG, deliberately: both answer "what kind of
      // person is this row" and the eye should find them in one pass down the
      // names rather than two passes across the table.
      // An account only has no username: the placeholder is an internal key.
      const who = (u.joined_at ? '<span class="who">@' + esc(u.handle) + '</span>' : '<span class="who">no username</span>') +
        (didToday(u) ? ' <span class="tag act">active ' + esc(dayName(viewDay || serverToday).toLowerCase()) + '</span>' : '') +
        ' <button class="more" data-msg="' + esc(u.handle) + '">Message</button>' +
        (u.robot ? ' <span class="tag">Google test robot</span>'
          // Joined nothing: backup and sync only, no public profile (0049).
          : !u.joined_at ? ' <span class="tag">account only</span>'
          : placeholder ? ' <span class="tag warn">no username yet</span>' : '') +
        (u.display_name ? '<div class="name">' + esc(u.display_name) + '</div>' : '');
      const how = esc((u.providers || '').split(',').join(', ')) +
        (u.unconfirmed ? ' <span class="tag warn">unconfirmed</span>' : '');
      return '<tr><td>' + who + '</td><td>' + plusCell(u) + '</td><td>' + grantCell(u.handle) +
        '</td><td>' + seenCell(u.last_seen_at) +
          (u.app_version ? '<div class="name">v' + esc(u.app_version) + '</div>' : '') +
        '</td><td>' + backupSyncCell(u) + '</td><td>' + todayCell(u) + '</td><td>' + how +
        '</td><td>' + esc(baghdad(u.created_at)) +
        '</td><td class="num">' + u.comments + '</td><td class="num">' + u.ratings +
        '</td><td class="num">' + u.feelings + '</td><td class="num">' + u.characters +
        '</td><td class="num">' + u.images + '</td><td class="num">' + u.lists +
        '</td><td class="num">' + num(u.episodes_watched, u) +
        '</td><td class="num">' + num(u.movies_watched, u) +
        '</td><td class="num">' + u.followers + '</td></tr>';
    }).join('') ||
    '<tr><td colspan="17" class="name">' + (on.length ? 'Nobody matches these filters.' : 'Nobody yet.') + '</td></tr>';
}

/**
 * The review queue. Nothing else in the system can make an image public, so
 * this is deliberately one picture, one caption, two buttons — no select-all,
 * no "approve the rest", no keyboard shortcut that could run away with a list.
 */
let reviewStatus = 'pending';


// ── Messages ("Message the developer", 1.6.7) ──────────────────────────────
const escm = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);
let chatWith = null;
async function loadThreads() {
  const res = await fetch('/v1/admin/support', { credentials: 'same-origin' });
  if (!res.ok) return;
  const { threads } = await res.json();
  const unread = threads.reduce((n, t) => n + (t.unread || 0), 0);
  $('msgcount').innerHTML = unread ? '<span class="thread"><span class="unread">' + unread + ' new</span></span>' : '';
  if (!threads.length) return;
  $('threads').innerHTML = threads.map((t) =>
    '<div class="thread" data-id="' + escm(t.profile_id) + '" data-name="' + escm(t.handle && t.joined_at ? '@' + t.handle : (t.display_name || 'account only')) + '">' +
    '<span class="who">' + escm(t.handle && t.joined_at ? '@' + t.handle : (t.display_name || 'account only')) + '</span>' +
    '<span class="last">' + escm(t.last_body) + '</span>' +
    (t.unread ? '<span class="unread">' + t.unread + '</span>' : '') +
    '<span class="note">' + escm(baghdad(t.last_at)) + '</span></div>').join('');
  for (const el of $('threads').querySelectorAll('.thread')) el.onclick = () => openChat(el.dataset.id, el.dataset.name);
}
/* WHATSAPP-STYLE TICKS on our own replies (13 Oct). ✓ saved, ✓✓ a phone
   accepted the notification, blue ✓✓ they opened the chat in the app. Kept on
   the message, so it is still there tomorrow — the popup it replaces was gone
   the moment it was closed. */
function ticks(m) {
  if (m.seenAt) return '<span class="tick read" title="Read ' + escm(baghdad(m.seenAt)) + '">✓✓</span>';
  if (m.push === 'delivered') return '<span class="tick" title="Delivered to their phone">✓✓</span>';
  if (m.push === 'nophone') return '<span class="tick" title="Saved — they have no phone that allows notifications; they will see it when they open the chat">✓</span>';
  if (m.push && m.push.indexOf('failed:') === 0) return '<span class="tick fail" title="Notification failed">✓ ' + escm(m.push.slice(7)) + '</span>';
  return '<span class="tick" title="Sent">✓</span>';
}
async function openChat(id, name) {
  chatWith = id;
  $('chatt').textContent = name;
  $('chatb').innerHTML = '<p class="note">Loading…</p>';
  $('chatdlg').showModal();
  const { messages } = await (await fetch('/v1/admin/support/' + encodeURIComponent(id), { credentials: 'same-origin' })).json();
  $('chatb').innerHTML = messages.map((m) =>
    '<div class="msg ' + (m.fromDev ? 'me' : 'them') + '">' + escm(m.body) + '<small>' + escm(baghdad(m.at)) + (m.fromDev ? ticks(m) : '') + '</small></div>').join('');
  $('chatb').scrollTop = $('chatb').scrollHeight;
  void loadThreads();
}
$('chatsend').onclick = async () => {
  const body = $('chatin').value.trim();
  if (!body || !chatWith) return;
  $('chatsend').disabled = true;
  const res = await fetch('/v1/admin/support/' + encodeURIComponent(chatWith), {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body }),
  });
  $('chatsend').disabled = false;
  if (!res.ok) { alert('Not sent (' + res.status + ')'); return; }
  $('chatin').value = '';
  await openChat(chatWith, $('chatt').textContent);
  // The result is drawn on the message itself now (see ticks).
};

async function loadReview() {
  const res = await fetch('/v1/admin/images?status=' + reviewStatus, { credentials: 'same-origin' });
  if (!res.ok) return;
  const { items = [] } = await res.json();
  const esc = (v) => String(v ?? '').replace(/[&<>"]/g, (ch) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));

  // Each status is a different sentence, because each is a different question:
  // what have I not decided, what am I publishing, what did I refuse.
  const notes = {
    pending: items.length + ' waiting. Nobody can see these until you decide. Scroll them before using "Show all" — that button clears exactly what is on this page, nothing that arrives later.',
    clean: items.length + ' visible to everyone right now, on the comment each belongs to. Block anything here and it stops being served.',
    blocked: items.length + ' refused. The file is still stored; nobody is served it.',
  };
  const empty = { pending: 'Nothing waiting.', clean: 'Nothing is being shown.', blocked: 'Nothing blocked.' };
  $('revnote').textContent = items.length ? notes[reviewStatus] : empty[reviewStatus];
  // "Show all" is a way to clear a backlog, not a way to re-approve or to undo
  // a block, so it belongs to the waiting list alone.
  $('bulkbar').hidden = items.length === 0 || reviewStatus !== 'pending';

  $('review').innerHTML = items.map((i) => {
    const where = i.season == null ? '' :
      ' · S' + i.season + (i.episode == null ? '' : 'E' + i.episode);
    return '<div class="shot" data-id="' + esc(i.comment_id) + '">' +
      '<img loading="lazy" src="/v1/admin/image/' + encodeURIComponent(i.comment_id) + '" alt="">' +
      '<div class="meta"><div class="who">@' + esc(i.handle) + (i.is_gif ? ' · GIF' : '') + '</div>' +
      '<div class="cap">' + esc(i.body || '(no caption)') + esc(where) + '</div></div>' +
      '<div class="btns">' +
      (reviewStatus === 'clean' ? '' : '<button data-do="clean">Show</button>') +
      (reviewStatus === 'blocked' ? '' : '<button class="no" data-do="blocked">Block</button>') +
      '</div></div>';
  }).join('');
}

$('dprev').addEventListener('click', () => stepDay(-1));
$('dnext').addEventListener('click', () => stepDay(1));

/* The people filter. Redraws from what is already loaded — see drawPeople. */
$('chips').addEventListener('click', (ev) => {
  const chip = ev.target.closest('.chip[data-f]');
  if (!chip) return;
  const id = chip.dataset.f;
  if (id === '__clear') activeFilters.clear();
  else if (activeFilters.has(id)) activeFilters.delete(id);
  else activeFilters.add(id);
  drawPeople();
});

$('tabs').addEventListener('click', (ev) => {
  const tab = ev.target.closest('.tab');
  if (!tab) return;
  reviewStatus = tab.dataset.status;
  [...$('tabs').children].forEach((b) => b.classList.toggle('on', b === tab));
  void loadReview();
});

$('showall').addEventListener('click', async () => {
  const ids = [...$('review').children].map((el) => el.dataset.id);
  if (!ids.length) return;
  // The one confirm on this page. A bulk approve is the only action here that
  // cannot be taken back one picture at a time.
  if (!confirm('Show all ' + ids.length + ' of these photos to everyone?')) return;
  $('showall').disabled = true;
  $('showall').textContent = 'Working…';
  const res = await fetch('/v1/admin/images/bulk', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ ids, status: 'clean' }),
  });
  $('showall').disabled = false;
  $('showall').textContent = 'Show all on this page';
  if (res.ok) { await load(); }
});

// Delegated, so buttons rendered after this file loads still work.
$('review').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-do]');
  if (!btn) return;
  const card = btn.closest('.shot');
  btn.disabled = true;
  const res = await fetch('/v1/admin/images/' + encodeURIComponent(card.dataset.id), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ status: btn.dataset.do }),
  });
  if (res.ok) card.remove();
  else btn.disabled = false;
  if (!$('review').children.length) void loadReview();
});

function show(ok) {
  $('login').hidden = ok;
  $('panel').hidden = !ok;
  $('out').hidden = !ok;
  $('refresh').hidden = !ok;
  $('hard').hidden = !ok;
  $('commsuni').hidden = !ok;
  if (ok) readCommsuni();
  $('event').hidden = !ok;
  if (ok) readEvent();
  $('sub').textContent = ok ? 'Community dashboard' : 'Sign in to continue';
  // The password field survives a failed sign-in; it must not survive a
  // successful one, and it must not be sitting in the DOM behind the panel.
  if (ok) { $('email').value = ''; $('password').value = ''; }
}

$('hard').addEventListener('click', async () => {
  $('hard').textContent = 'Reading…';
  try {
    await fetch('/v1/admin/cache/clear', { method: 'POST', credentials: 'same-origin' });
    await load();
  } finally {
    $('hard').textContent = 'Hard refresh';
  }
});

const EVENT_NAMES = {
  halloween: 'Halloween', muertos: 'Day of the Dead', christmas: 'Christmas', newyear: 'New Year',
  valentine: "Valentine's", ramadan: 'Ramadan & Eid', awards: 'Awards season',
};
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function niceDay(d) { return Number(d.slice(8)) + ' ' + SHORT_MONTHS[Number(d.slice(5, 7)) - 1]; }
let eventState;
function eventOptions() {
  const auto = eventState && eventState.mode === 'auto';
  const now = eventState && eventState.event ? EVENT_NAMES[eventState.event] : 'nothing';
  const next = eventState && eventState.next
    ? ' → ' + (eventState.next.event ? EVENT_NAMES[eventState.next.event] : 'off') + ' on ' + niceDay(eventState.next.day)
    : '';
  return '<option value="">Event: off</option>' +
    '<option value="auto">Event: automatic' + (auto ? ' (now ' + now + next + ')' : ' — follows the calendar') + '</option>' +
    Object.entries(EVENT_NAMES).map(([k, v]) => '<option value="' + k + '">Event: ' + v + ' (fixed)</option>').join('');
}
function drawEvent() {
  $('event').innerHTML = eventOptions();
  $('event').value = !eventState ? '' : eventState.mode === 'auto' ? 'auto' : (eventState.event || '');
}
async function readEvent() {
  const res = await fetch('/v1/admin/event', { credentials: 'same-origin' });
  eventState = res.ok ? await res.json() : undefined;
  drawEvent();
}
$('event').addEventListener('change', async () => {
  if (eventState === undefined) return drawEvent();
  const next = $('event').value || null;
  const msg = next === 'auto'
    ? 'Switch seasons automatically by date? Halloween 1–31 Oct, Day of the Dead 1–2 Nov, Christmas 1–26 Dec, New Year 27 Dec–2 Jan, Valentine’s 7–14 Feb, Ramadan & Eid on its dates. Awards season stays manual. Changes reach phones within 5 minutes of midnight UTC.'
    : next
      ? 'Turn on ' + EVENT_NAMES[next] + ' and keep it until you change it? Members get its decorations and theme within 5 minutes; free users lose them when it ends, Plus keeps them.'
      : 'Turn the seasonal event off? Free users lose the decorations within 5 minutes.';
  if (!confirm(msg)) return drawEvent();
  const res = await fetch('/v1/admin/event', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ event: next }),
  });
  if (res.ok) eventState = await res.json();
  drawEvent();
});

// ── Profile templates (0053) ────────────────────────────────────────────────
// The phone names the persona and the event in its own language; these are
// the English for this page only.
const PERSONA_NAMES = {
  binger: 'The Binger', filmBuff: 'The Film Buff', explorer: 'The Explorer', nostalgic: 'The Nostalgic',
  completionist: 'The Completionist', critic: 'The Critic', curator: 'The Curator', devotee: 'The Devotee',
  feeler: 'The Feeler', newcomer: 'The Newcomer', spooky: 'The Spooky One', festive: 'The Festive One',
};
$('tplpersona').innerHTML = Object.entries(PERSONA_NAMES).map(([k, v]) =>
  '<option value="' + k + '">Persona: ' + v + '</option>').join('');
$('tpllayout').innerHTML = [['cards', 'grid'], ['classic', 'row'], ['poster', 'compact']].map(([k, v]) =>
  '<option value="' + k + '">Layout: ' + v + '</option>').join('');
$('tplevent').innerHTML = '<option value="">Shown: always</option>' +
  Object.entries(EVENT_NAMES).map(([k, v]) => '<option value="' + k + '">Shown: only during ' + v + '</option>').join('');
// The Midnight template's order, as a starting point.
$('tplblocks').value = ['banners', 'intro', 'counts', 'nowWatching:2x2', 'binge + streak', 'stats', 'activity:2x1',
  'thisYear + finished', 'shelf:shows', 'shelf:fav-shows', 'shelf:movies', 'shelf:fav-movies', 'lists', 'extra'].join('\\n');

async function loadTemplates() {
  const res = await fetch('/v1/admin/templates', { credentials: 'same-origin' });
  if (!res.ok) return;
  const { items = [] } = await res.json();
  if (!items.length) { $('tpllist').innerHTML = '<p class="note">None yet.</p>'; return; }
  $('tpllist').innerHTML = items.map((t) =>
    '<div class="shot' + (t.hidden ? ' off' : '') + '" data-id="' + escm(t.id) + '">' +
    '<img loading="lazy" src="' + escm(t.banner) + '" alt="">' +
    '<div class="meta"><div class="who">' + escm(t.name) +
    (t.hidden ? ' <span class="tag gone">hidden</span>' : '') +
    (t.event ? ' <span class="tag warn">' + escm(EVENT_NAMES[t.event] || t.event) + '</span>' : '') + '</div>' +
    '<div class="cap"><span class="sw" style="background:' + escm(t.primary) + '"></span>' +
    '<span class="sw" style="background:' + escm(t.secondary) + '"></span> ' +
    escm(PERSONA_NAMES[t.persona] || t.persona) + ' &middot; ' + escm(t.layout) + ' &middot; ' +
    (Array.isArray(t.blocks) ? t.blocks.length : 0) + ' blocks &middot; ' + escm(String(t.created_at).slice(0, 10)) + '</div></div>' +
    '<div class="btns"><button data-hide="' + (t.hidden ? '0' : '1') + '">' + (t.hidden ? 'Show' : 'Hide') + '</button>' +
    '<button class="no" data-del="1">Delete</button></div></div>').join('');
}

$('tpllist').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button');
  if (!btn) return;
  const card = btn.closest('.shot');
  const id = card.dataset.id;
  if (btn.dataset.del) {
    if (!confirm('Delete this template? It leaves phones within 5 minutes; anyone who already applied it keeps their look.')) return;
    btn.disabled = true;
    const res = await fetch('/v1/admin/templates/' + encodeURIComponent(id), { method: 'DELETE', credentials: 'same-origin' });
    if (res.ok) card.remove(); else btn.disabled = false;
    if (!$('tpllist').querySelector('.shot')) void loadTemplates();
    return;
  }
  btn.disabled = true;
  const res = await fetch('/v1/admin/templates/' + encodeURIComponent(id), {
    method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hidden: btn.dataset.hide === '1' }),
  });
  if (!res.ok) btn.disabled = false;
  void loadTemplates();
});

$('tplform').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('tplerr').textContent = '';
  const fd = new FormData();
  fd.set('name', $('tplname').value);
  fd.set('layout', $('tpllayout').value);
  fd.set('primary', $('tplc1').value);
  fd.set('secondary', $('tplc2').value);
  fd.set('persona', $('tplpersona').value);
  fd.set('event', $('tplevent').value);
  fd.set('blocks', $('tplblocks').value);
  const file = $('tplimg').files[0];
  if (file) fd.set('image', file, file.name);
  const btn = $('tplform').querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/v1/admin/templates', { method: 'POST', credentials: 'same-origin', body: fd });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) { $('tplerr').textContent = (out.error && out.error.message) || 'That did not work.'; return; }
    $('tplname').value = '';
    $('tplimg').value = '';
    await loadTemplates();
  } finally {
    btn.disabled = false;
  }
});

let commsuniOn = null;
function drawCommsuni() {
  $('commsuni').textContent = commsuniOn == null ? 'CommsUni: …' : commsuniOn ? 'CommsUni: on' : 'CommsUni: OFF';
}
async function readCommsuni() {
  const res = await fetch('/v1/admin/commsuni', { credentials: 'same-origin' });
  commsuniOn = res.ok ? (await res.json()).on : null;
  drawCommsuni();
}
$('commsuni').addEventListener('click', async () => {
  if (commsuniOn == null) return;
  const next = !commsuniOn;
  if (!confirm(next
    ? 'Turn CommsUni back on? Every community member sees the archive again.'
    : 'Turn CommsUni off for everybody? No phone will show or send CommsUni comments until you turn it back on.')) return;
  const res = await fetch('/v1/admin/commsuni', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ on: next }),
  });
  if (res.ok) commsuniOn = (await res.json()).on;
  drawCommsuni();
});

$('refresh').addEventListener('click', () => {
  $('refresh').textContent = 'Reading…';
  load().finally(() => { $('refresh').textContent = 'Refresh'; });
});

$('login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('err').textContent = '';
  const res = await fetch('/v1/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ email: $('email').value, password: $('password').value }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    $('err').textContent = (body.error && body.error.message) || 'That did not work.';
    return;
  }
  $('password').value = '';
  load();
});

$('out').addEventListener('click', async () => {
  await fetch('/v1/admin/logout', { method: 'POST', credentials: 'same-origin' });
  show(false);
});

// Once, before the first render. The rows are replaced on every refresh, so
// the listener lives on the table rather than on the buttons inside it.
wirePlus();
wireMore();
wireMessage();
load();
</script>
</body>
</html>`;
