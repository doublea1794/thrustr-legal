// Thrustr for Gyms: sign in, set up a gym, post a workout per day.
(() => {
  "use strict";

  const cfg = window.THRUSTR;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const $ = (id) => document.getElementById(id);
  const VIEWS = ["view-loading", "view-auth", "view-reset", "view-setup", "view-main"];

  const state = {
    session: null,
    gyms: [],
    gym: null,
    weekStart: mondayOf(new Date()),
    selected: ymd(new Date()),
    saved: new Map(),   // day -> { body, updated_at }
    drafts: new Map(),  // day -> unsaved text
    authMode: "signin", // or "signup"
    recovering: false,
    busy: false,
  };

  // ---------- Dates (local, as YYYY-MM-DD) ----------

  function ymd(d) {
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${d.getFullYear()}-${m}-${day}`;
  }
  function fromYmd(s) {
    const [y, m, d] = s.split("-").map(Number);
    return new Date(y, m - 1, d);
  }
  function addDays(d, n) {
    const c = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    c.setDate(c.getDate() + n);
    return c;
  }
  function mondayOf(d) {
    const day = d.getDay(); // 0 = Sunday
    return addDays(d, day === 0 ? -6 : 1 - day);
  }
  const fmt = {
    weekday: new Intl.DateTimeFormat(undefined, { weekday: "short" }),
    long: new Intl.DateTimeFormat(undefined, { weekday: "long", month: "long", day: "numeric" }),
    month: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }),
    time: new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }),
    dayTime: new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  };

  // ---------- Small helpers ----------

  function show(view) {
    for (const v of VIEWS) $(v).hidden = v !== view;
    $("topbar-right").hidden = !(view === "view-main" || view === "view-setup");
  }
  function msg(el, text, kind) {
    el.textContent = text || "";
    el.className = "form-msg" + (kind ? " " + kind : "");
  }
  function friendly(error) {
    const text = (error && (error.message || error.error_description)) || String(error || "");
    if (/invalid login credentials/i.test(text)) return "That email and password don't match.";
    if (/email not confirmed/i.test(text)) return "Confirm your email first. Check your inbox for the link.";
    if (/already registered|already been registered/i.test(text)) return "There's already an account with that email. Sign in instead.";
    if (/rate limit|too many/i.test(text)) return "Too many tries. Wait a minute and try again.";
    if (/failed to fetch|network/i.test(text)) return "Can't reach Thrustr. Check your connection and try again.";
    if (/password/i.test(text) && /least|short|weak/i.test(text)) return "Use a longer password (at least 8 characters).";
    return text || "Something went wrong. Try again.";
  }
  function setBusy(button, busy, label) {
    button.disabled = busy;
    if (label) button.textContent = label;
  }

  // ---------- Auth ----------

  function renderAuthMode() {
    const signup = state.authMode === "signup";
    $("auth-title").textContent = signup ? "Create your gym account" : "Sign in";
    $("auth-submit").textContent = signup ? "Create account" : "Sign in";
    $("auth-toggle").textContent = signup ? "Already have an account? Sign in" : "New gym? Create an account";
    $("auth-forgot").hidden = signup;
    $("auth-password").autocomplete = signup ? "new-password" : "current-password";
    msg($("auth-msg"), signup ? "Use at least 8 characters for your password." : "");
  }

  $("auth-toggle").addEventListener("click", () => {
    state.authMode = state.authMode === "signup" ? "signin" : "signup";
    renderAuthMode();
  });

  $("auth-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("auth-email").value.trim();
    const password = $("auth-password").value;
    const out = $("auth-msg");
    if (!email || !/.+@.+\..+/.test(email)) return msg(out, "Enter your email.", "error");
    if (password.length < 8) return msg(out, "Use at least 8 characters for your password.", "error");

    const button = $("auth-submit");
    const label = button.textContent;
    setBusy(button, true, state.authMode === "signup" ? "Creating account…" : "Signing in…");
    try {
      if (state.authMode === "signup") {
        const { data, error } = await sb.auth.signUp({
          email, password, options: { emailRedirectTo: location.origin + location.pathname },
        });
        if (error) throw error;
        if (!data.session) {
          msg(out, `Almost there. We sent a confirmation link to ${email}. Open it, then sign in here.`, "ok");
          state.authMode = "signin";
          $("auth-title").textContent = "Sign in";
          $("auth-toggle").textContent = "New gym? Create an account";
          $("auth-forgot").hidden = false;
          setBusy(button, false, "Sign in");
          return;
        }
      } else {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
      // onAuthStateChange takes it from here.
    } catch (err) {
      msg(out, friendly(err), "error");
      setBusy(button, false, label);
    }
  });

  $("auth-forgot").addEventListener("click", async () => {
    const email = $("auth-email").value.trim();
    const out = $("auth-msg");
    if (!email) {
      $("auth-email").focus();
      return msg(out, "Enter your email above, then tap Forgot password again.", "error");
    }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
    if (error) return msg(out, friendly(error), "error");
    msg(out, `If there's an account for ${email}, a reset link is on its way.`, "ok");
  });

  $("reset-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = $("reset-password").value;
    const out = $("reset-msg");
    if (password.length < 8) return msg(out, "Use at least 8 characters.", "error");
    const { error } = await sb.auth.updateUser({ password });
    if (error) return msg(out, friendly(error), "error");
    state.recovering = false;
    history.replaceState(null, "", location.pathname);
    route();
  });

  $("sign-out").addEventListener("click", async () => {
    if (state.drafts.size && !confirm("You have workouts that aren't posted yet. Sign out anyway?")) return;
    state.drafts.clear();
    await sb.auth.signOut();
  });

  // ---------- Routing ----------

  async function route() {
    if (state.recovering) return show("view-reset");
    if (!state.session) {
      renderAuthMode();
      setBusy($("auth-submit"), false, state.authMode === "signup" ? "Create account" : "Sign in");
      return show("view-auth");
    }
    show("view-loading");
    const { data, error } = await sb.from("gyms").select("id, name, address, join_code, created_at").order("created_at");
    if (error) {
      show("view-auth");
      return msg($("auth-msg"), friendly(error), "error");
    }
    state.gyms = data || [];
    if (!state.gyms.length) return openSetup(false);
    let remembered = null;
    try { remembered = localStorage.getItem("thrustr.gym"); } catch (_) {}
    const pick = state.gyms.find((g) => g.id === (state.gym && state.gym.id))
      || state.gyms.find((g) => g.id === remembered)
      || state.gyms[0];
    await selectGym(pick);
  }

  sb.auth.onAuthStateChange((event, session) => {
    const wasSignedIn = !!state.session;
    state.session = session;
    if (event === "PASSWORD_RECOVERY") state.recovering = true;
    // Don't call Supabase inside this callback; let it finish first.
    if (event === "SIGNED_IN" && wasSignedIn) return; // token refresh on tab focus
    if (event === "TOKEN_REFRESHED" || event === "USER_UPDATED") return;
    setTimeout(route, 0);
  });

  // ---------- Gym setup ----------

  function openSetup(canCancel) {
    $("setup-form").reset();
    msg($("setup-msg"), "");
    $("setup-title").textContent = canCancel ? "Add another gym" : "Add your gym";
    $("setup-cancel").hidden = !canCancel;
    document.querySelector("#setup-form .eyebrow").hidden = canCancel;
    $("gym-picker").hidden = true;
    show("view-setup");
    $("setup-name").focus();
  }

  $("setup-cancel").addEventListener("click", () => selectGym(state.gym || state.gyms[0]));
  $("add-gym").addEventListener("click", () => openSetup(true));

  $("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("setup-name").value.trim();
    const address = $("setup-address").value.trim();
    const out = $("setup-msg");
    if (!name) return msg(out, "Enter your gym's name.", "error");
    const button = e.submitter || $("setup-form").querySelector("button[type=submit]");
    setBusy(button, true, "Creating…");
    const { data, error } = await sb.from("gyms").insert({ name, address }).select("id, name, address, join_code, created_at").single();
    setBusy(button, false, "Create gym");
    if (error) return msg(out, friendly(error), "error");
    state.gyms.push(data);
    await selectGym(data);
    setTab("members");
  });

  // ---------- Main ----------

  async function selectGym(gym) {
    state.gym = gym;
    try { localStorage.setItem("thrustr.gym", gym.id); } catch (_) {}
    state.saved.clear();
    state.drafts.clear();
    renderGymHeader();
    show("view-main");
    await loadWeek();
  }

  function renderGymHeader() {
    const gym = state.gym;
    $("gym-name").textContent = gym.name;
    $("gym-address").textContent = gym.address || "";
    $("gym-address").hidden = !gym.address;

    const picker = $("gym-picker");
    picker.hidden = state.gyms.length < 2;
    picker.innerHTML = "";
    for (const g of state.gyms) {
      const o = document.createElement("option");
      o.value = g.id;
      o.textContent = g.name;
      o.selected = g.id === gym.id;
      picker.appendChild(o);
    }

    $("gym-edit-name").value = gym.name;
    $("gym-edit-address").value = gym.address || "";
    renderSign();
  }

  $("gym-picker").addEventListener("change", (e) => {
    const next = state.gyms.find((g) => g.id === e.target.value);
    if (!next) return;
    if (state.drafts.size && !confirm("You have workouts that aren't posted yet. Switch gyms anyway?")) {
      e.target.value = state.gym.id;
      return;
    }
    selectGym(next);
  });

  // Tabs
  function setTab(name) {
    for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t.dataset.tab === name));
    for (const p of ["workouts", "members", "gym"]) $("panel-" + p).hidden = p !== name;
  }
  for (const t of document.querySelectorAll(".tab")) t.addEventListener("click", () => setTab(t.dataset.tab));

  // ---------- Week and days ----------

  async function loadWeek() {
    renderWeek();
    const from = ymd(state.weekStart);
    const to = ymd(addDays(state.weekStart, 6));
    const gymId = state.gym.id;
    const { data, error } = await sb.from("gym_workouts")
      .select("day, body, updated_at")
      .eq("gym_id", gymId)
      .gte("day", from)
      .lte("day", to);
    if (state.gym.id !== gymId) return;
    if (error) {
      msg($("editor-msg"), friendly(error), "error");
      return;
    }
    for (const row of data) state.saved.set(row.day, { body: row.body, updated_at: row.updated_at });
    renderWeek();
    renderEditor();
  }

  function dayState(day) {
    if (state.drafts.has(day)) return "draft";
    if (state.saved.has(day)) return "posted";
    return "";
  }

  function renderWeek() {
    const start = state.weekStart;
    const end = addDays(start, 6);
    $("week-label").textContent = `${fmt.month.format(start)} – ${fmt.month.format(end)}`;
    const today = ymd(new Date());
    const wrap = $("days");
    wrap.innerHTML = "";
    for (let i = 0; i < 7; i++) {
      const date = addDays(start, i);
      const key = ymd(date);
      const st = dayState(key);
      const b = document.createElement("button");
      b.type = "button";
      b.className = "day" + (st ? " " + st : "") + (key === today ? " today" : "");
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(key === state.selected));
      b.dataset.day = key;
      const stateText = st === "draft" ? "Unsaved" : st === "posted" ? "Posted" : "";
      b.setAttribute("aria-label", `${fmt.long.format(date)}${stateText ? ", " + stateText : ""}`);
      b.innerHTML = `<span class="day-name"></span><span class="day-num"></span><span class="day-state">${st ? '<span class="dot"></span><span class="label"></span>' : ""}</span>`;
      b.querySelector(".day-name").textContent = fmt.weekday.format(date);
      b.querySelector(".day-num").textContent = String(date.getDate());
      if (st) b.querySelector(".label").textContent = stateText;
      b.addEventListener("click", () => pickDay(key));
      wrap.appendChild(b);
    }
  }

  function pickDay(key) {
    stashDraft();
    state.selected = key;
    renderWeek();
    renderEditor();
  }

  async function moveWeek(delta) {
    stashDraft();
    state.weekStart = addDays(state.weekStart, delta * 7);
    // Keep the same weekday selected in the new week.
    state.selected = ymd(addDays(fromYmd(state.selected), delta * 7));
    renderEditor();
    await loadWeek();
  }
  $("week-prev").addEventListener("click", () => moveWeek(-1));
  $("week-next").addEventListener("click", () => moveWeek(1));
  $("week-today").addEventListener("click", async () => {
    stashDraft();
    state.selected = ymd(new Date());
    const monday = mondayOf(new Date());
    const changed = ymd(monday) !== ymd(state.weekStart);
    state.weekStart = monday;
    renderEditor();
    if (changed) await loadWeek(); else renderWeek();
  });

  // ---------- Editor ----------

  const editor = $("editor-body");

  function stashDraft() {
    const day = state.selected;
    const text = editor.value;
    const saved = state.saved.get(day);
    if (text.trim() === (saved ? saved.body : "").trim()) state.drafts.delete(day);
    else state.drafts.set(day, text);
  }

  function renderEditor() {
    const day = state.selected;
    const saved = state.saved.get(day);
    $("editor-day").textContent = fmt.long.format(fromYmd(day));
    editor.value = state.drafts.has(day) ? state.drafts.get(day) : (saved ? saved.body : "");
    $("editor-delete").hidden = !saved;
    $("editor-save").textContent = saved ? "Update workout" : "Post workout";
    msg($("editor-msg"), "");
    renderStatus();
  }

  function renderStatus() {
    const day = state.selected;
    const saved = state.saved.get(day);
    const el = $("editor-status");
    const dirty = editor.value.trim() !== (saved ? saved.body : "").trim();
    if (dirty && (saved || editor.value.trim())) {
      el.textContent = saved ? "Unsaved changes" : "Not posted yet";
      el.className = "status draft";
    } else if (saved) {
      const at = new Date(saved.updated_at);
      const sameDay = ymd(at) === ymd(new Date());
      el.textContent = `Posted · updated ${sameDay ? fmt.time.format(at) : fmt.dayTime.format(at)}`;
      el.className = "status posted";
    } else {
      el.textContent = "Nothing posted";
      el.className = "status";
    }
    $("editor-save").disabled = !editor.value.trim() || !dirty || state.busy;
  }

  editor.addEventListener("input", () => {
    stashDraft();
    renderStatus();
    // Update just this day's pill state.
    const pill = document.querySelector(`.day[data-day="${state.selected}"]`);
    if (pill) {
      const st = dayState(state.selected);
      pill.classList.toggle("draft", st === "draft");
      pill.classList.toggle("posted", st === "posted");
      const stateText = st === "draft" ? "Unsaved" : st === "posted" ? "Posted" : "";
      pill.querySelector(".day-state").innerHTML = st ? `<span class="dot"></span><span class="label">${stateText}</span>` : "";
    }
  });

  editor.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!$("editor-save").disabled) save();
    }
  });

  async function save() {
    const day = state.selected;
    const body = editor.value.replace(/\s+$/, "");
    if (!body.trim()) return;
    state.busy = true;
    const button = $("editor-save");
    setBusy(button, true, "Posting…");
    const { data, error } = await sb.from("gym_workouts")
      .upsert({ gym_id: state.gym.id, day, body }, { onConflict: "gym_id,day" })
      .select("day, body, updated_at")
      .single();
    state.busy = false;
    if (error) {
      setBusy(button, false, state.saved.has(day) ? "Update workout" : "Post workout");
      msg($("editor-msg"), friendly(error), "error");
      renderStatus();
      return;
    }
    state.saved.set(data.day, { body: data.body, updated_at: data.updated_at });
    state.drafts.delete(day);
    if (state.selected === day) {
      renderEditor();
      msg($("editor-msg"), "Posted. Members will see it next time they open Thrustr.", "ok");
    }
    renderWeek();
  }
  $("editor-save").addEventListener("click", save);

  $("editor-delete").addEventListener("click", async () => {
    const day = state.selected;
    if (!confirm(`Remove the workout for ${fmt.long.format(fromYmd(day))}? Members' apps will drop it too.`)) return;
    const { error } = await sb.from("gym_workouts").delete().eq("gym_id", state.gym.id).eq("day", day);
    if (error) return msg($("editor-msg"), friendly(error), "error");
    state.saved.delete(day);
    state.drafts.delete(day);
    renderWeek();
    renderEditor();
    msg($("editor-msg"), "Removed.", "ok");
  });

  window.addEventListener("beforeunload", (e) => {
    if (state.session && state.gym) stashDraft();
    if (state.drafts.size) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // ---------- Members sign ----------

  function gymLink(gym) {
    // Kept short so the QR code stays easy to scan. The app looks up the rest.
    const p = new URLSearchParams({ id: gym.id, name: gym.name });
    // URLSearchParams writes spaces as "+"; the app reads "%20".
    return "thrustr://gym?" + p.toString().replace(/\+/g, "%20");
  }

  function qrSvg(text) {
    const qr = window.qrcode(0, "M");
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const quiet = 2;
    const size = n + quiet * 2;
    let path = "";
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (qr.isDark(r, c)) path += `M${c + quiet} ${r + quiet}h1v1h-1z`;
      }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code to connect to this gym in Thrustr"><rect width="${size}" height="${size}" fill="#fff"/><path d="${path}" fill="#0a0a0a"/></svg>`;
  }

  function prettyCode(code) {
    return code.length === 6 ? code.slice(0, 3) + " " + code.slice(3) : code;
  }

  function renderSign() {
    const gym = state.gym;
    $("sign-gym").textContent = gym.name;
    $("sign-code").textContent = prettyCode(gym.join_code);
    $("sign-qr").innerHTML = qrSvg(gymLink(gym));
    $("share-text").value = `Get our daily workouts in the Thrustr app: tap "Connect your gym", then "Enter a gym code" and type ${gym.join_code}.`;
    msg($("copy-msg"), "");
  }

  $("print-sign").addEventListener("click", () => {
    setTab("members");
    window.print();
  });

  $("copy-share").addEventListener("click", async () => {
    const input = $("share-text");
    try {
      await navigator.clipboard.writeText(input.value);
    } catch (_) {
      input.select();
      document.execCommand("copy");
    }
    msg($("copy-msg"), "Copied.", "ok");
  });

  // ---------- Gym details ----------

  $("gym-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("gym-edit-name").value.trim();
    const address = $("gym-edit-address").value.trim();
    const out = $("gym-msg");
    if (!name) return msg(out, "Enter your gym's name.", "error");
    const { data, error } = await sb.from("gyms").update({ name, address }).eq("id", state.gym.id)
      .select("id, name, address, join_code, created_at").single();
    if (error) return msg(out, friendly(error), "error");
    const i = state.gyms.findIndex((g) => g.id === data.id);
    if (i >= 0) state.gyms[i] = data;
    state.gym = data;
    renderGymHeader();
    msg(out, "Saved.", "ok");
  });

  // ---------- Start ----------

  // A reset-password link lands here with type=recovery in the URL.
  if (/type=recovery/.test(location.hash) || /type=recovery/.test(location.search)) state.recovering = true;
  // The first screen is picked when Supabase reports the saved session (INITIAL_SESSION above).
})();
