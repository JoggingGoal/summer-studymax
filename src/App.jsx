import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Flame, Users, Calendar as CalIcon, Trophy, Plus, Check, X, Clock,
  Video, ThumbsUp, ThumbsDown, ChevronLeft, ChevronRight, Copy, LogOut,
  AlertCircle, Loader2, Skull, PartyPopper
} from "lucide-react";
import { supabase } from "./supabaseClient.js";

/* ============================================================
   CONSTANTS — these are now DEFAULTS only. Each group stores its own
   copy in group.settings, which any member can edit from Group > Settings.
============================================================ */
const DEFAULT_SETTINGS = {
  weekdayHours: 4,
  weekendHours: 3,
  deadlineHour: 23, // 23:59 = 11:59 PM
  deadlineMin: 59,
  voteThreshold: "majority", // "majority" (>50% of others) or "unanimous"
};

function getSettings(group) {
  return { ...DEFAULT_SETTINGS, ...(group.settings || {}) };
}

const STATUS = {
  MET: "met",
  MISSED: "missed",
  EXEMPT_FULL: "exempt_full",
  EXEMPT_PARTIAL: "exempt_partial",
  PENDING: "pending", // today, not yet resolved
  FUTURE: "future",
};

/* ============================================================
   TIME HELPERS — everything keyed to US Eastern Time
============================================================ */
function easternNow() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const m = {};
  parts.forEach(p => (m[p.type] = p.value));
  return {
    dateStr: `${m.year}-${m.month}-${m.day}`,
    hour: parseInt(m.hour, 10),
    minute: parseInt(m.minute, 10),
  };
}

function dateStrToday() {
  return easternNow().dateStr;
}

function isPastDeadline(dateStr, settings) {
  const s = settings || DEFAULT_SETTINGS;
  const cur = easternNow();
  if (dateStr < cur.dateStr) return true;
  if (dateStr > cur.dateStr) return false;
  return cur.hour > s.deadlineHour || (cur.hour === s.deadlineHour && cur.minute > s.deadlineMin);
}

function isWeekend(dateStr) {
  // dateStr is YYYY-MM-DD, treat as Eastern calendar date (no TZ shift needed since we only need day-of-week)
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay();
  return dow === 0 || dow === 6;
}

function requiredHours(dateStr, settings) {
  const s = settings || DEFAULT_SETTINGS;
  return isWeekend(dateStr) ? s.weekendHours : s.weekdayHours;
}

function fmtDateLong(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const da = Date.UTC(ay, am - 1, ad);
  const db = Date.UTC(by, bm - 1, bd);
  return Math.round((db - da) / 86400000);
}

function monthLabel(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, 1));
  return dt.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

function fmtDeadline(settings) {
  const s = settings || DEFAULT_SETTINGS;
  const h24 = s.deadlineHour;
  const period = h24 >= 12 ? "PM" : "AM";
  let h12 = h24 % 12;
  if (h12 === 0) h12 = 12;
  const mm = String(s.deadlineMin).padStart(2, "0");
  return `${h12}:${mm} ${period} ET`;
}

/* ============================================================
   STORAGE HELPERS
   - "Shared" data (the group's state) lives in Supabase, in a single
     row per group code, so every friend's device reads/writes the
     same record. Realtime subscriptions push updates live.
   - "Personal" data (just your own identity: name + which group you're
     in) lives in localStorage, since that's specific to this device.
============================================================ */
async function loadGroup(code) {
  try {
    const { data, error } = await supabase
      .from("groups")
      .select("data")
      .eq("code", code)
      .maybeSingle();
    if (error) throw error;
    return data ? data.data : null;
  } catch (err) {
    console.error("loadGroup failed:", err);
    return null;
  }
}

async function saveGroup(code, value) {
  try {
    const { error } = await supabase
      .from("groups")
      .upsert({ code, data: value }, { onConflict: "code" });
    if (error) throw error;
    return true;
  } catch (err) {
    console.error("saveGroup failed:", err);
    return false;
  }
}

function loadPersonal(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function savePersonal(key, value) {
  try {
    if (value === null || value === undefined) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify(value));
    }
    return true;
  } catch {
    return false;
  }
}

function genCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 5; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}
function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/* ============================================================
   GROUP DATA SHAPE (stored under groups:<code>)
   {
     code, name, createdAt, startDate, forfeit,
     members: [{id, name, joinedAt}],
     logs: { [dateStr]: { [memberId]: { hours, note } } },
     exemptionRequests: [{id, memberId, date, type:'full'|'partial', partialHours, reason, votes:{memberId:'yes'|'no'}, status:'open'|'granted'|'denied', createdAt}],
     // a member can submit multiple timelapse clips for the same day — each is its own
     // entry here with its own independent vote
     timelapseVotes: [{id, memberId, date, url, label, votes:{memberId:'yes'|'no'}, status:'open'|'counted'|'rejected', createdAt}]
   }
============================================================ */

const VOTE_THRESHOLD_RATIO = 0.5; // strictly more than half of OTHER members must vote yes

function tallyVotes(votesObj, totalOtherMembers, voteThreshold = "majority") {
  const yes = Object.values(votesObj || {}).filter(v => v === "yes").length;
  const no = Object.values(votesObj || {}).filter(v => v === "no").length;
  const needed = voteThreshold === "unanimous" ? totalOtherMembers : Math.floor(totalOtherMembers / 2) + 1;
  return { yes, no, needed, passed: yes >= needed && totalOtherMembers > 0 };
}

/* ============================================================
   DAY STATUS COMPUTATION
============================================================ */
function computeDayStatus(group, dateStr, memberId) {
  const settings = getSettings(group);
  if (dateStr > dateStrToday()) return { status: STATUS.FUTURE, hoursLogged: 0, required: requiredHours(dateStr, settings) };
  const required = requiredHours(dateStr, settings);
  const log = group.logs?.[dateStr]?.[memberId];
  const hoursLogged = log?.hours || 0;

  // exemption?
  const exemption = (group.exemptionRequests || []).find(
    e => e.memberId === memberId && e.date === dateStr && e.status === "granted"
  );

  const pastDeadline = isPastDeadline(dateStr, settings);

  if (exemption) {
    if (exemption.type === "full") {
      return { status: STATUS.EXEMPT_FULL, hoursLogged, required, exemption };
    } else {
      const effectiveRequired = Math.max(0, required - (exemption.partialHours || 0));
      if (!pastDeadline && hoursLogged < effectiveRequired) {
        return { status: STATUS.PENDING, hoursLogged, required: effectiveRequired, exemption };
      }
      return {
        status: hoursLogged >= effectiveRequired ? STATUS.EXEMPT_PARTIAL : STATUS.MISSED,
        hoursLogged, required: effectiveRequired, exemption,
      };
    }
  }

  if (!pastDeadline) {
    if (hoursLogged >= required) return { status: STATUS.MET, hoursLogged, required };
    return { status: STATUS.PENDING, hoursLogged, required };
  }

  return { status: hoursLogged >= required ? STATUS.MET : STATUS.MISSED, hoursLogged, required };
}

function pointsForStatus(s) {
  // points are BAD — most points at the end LOSES
  if (s === STATUS.MISSED) return 1;
  return 0;
}

/* ============================================================
   ICONS / VISUAL HELPERS
============================================================ */
const STATUS_STYLE = {
  [STATUS.MET]: { bg: "var(--c-green)", fg: "var(--c-cream)", label: "Logged" },
  [STATUS.MISSED]: { bg: "var(--c-red)", fg: "var(--c-cream)", label: "Missed" },
  [STATUS.EXEMPT_FULL]: { bg: "var(--c-amber)", fg: "var(--c-ink)", label: "Exempt" },
  [STATUS.EXEMPT_PARTIAL]: { bg: "var(--c-amber)", fg: "var(--c-ink)", label: "Partial exempt" },
  [STATUS.PENDING]: { bg: "var(--c-pending)", fg: "var(--c-cream)", label: "In progress" },
  [STATUS.FUTURE]: { bg: "var(--c-future)", fg: "var(--c-sage)", label: "Upcoming" },
};

/* ============================================================
   ROOT APP
============================================================ */
export default function App() {
  const [booting, setBooting] = useState(true);
  const [identity, setIdentity] = useState(null); // {memberId, name, groupCode}
  const [group, setGroup] = useState(null);
  const [tab, setTab] = useState("calendar");
  const [toast, setToast] = useState(null);
  const channelRef = useRef(null);

  const showToast = useCallback((msg, kind = "info") => {
    setToast({ msg, kind, id: genId() });
    setTimeout(() => setToast(t => (t && t.msg === msg ? null : t)), 3200);
  }, []);

  // boot: load personal identity from this device, then fetch the group once
  useEffect(() => {
    (async () => {
      const saved = loadPersonal("identity", null);
      if (saved) {
        setIdentity(saved);
        const g = await loadGroup(saved.groupCode);
        setGroup(g);
      }
      setBooting(false);
    })();
  }, []);

  // subscribe to live updates for this group via Supabase Realtime, so
  // every friend's screen updates the moment anyone saves a change —
  // no polling needed. Falls back to a 5s safety poll in case a realtime
  // event is ever missed (e.g. brief network drop).
  useEffect(() => {
    if (!identity) return;

    async function refresh() {
      const g = await loadGroup(identity.groupCode);
      if (g) setGroup(g);
    }
    refresh();

    const channel = supabase
      .channel(`group-${identity.groupCode}`)
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "groups", filter: `code=eq.${identity.groupCode}` },
        (payload) => {
          if (payload.new && payload.new.data) setGroup(payload.new.data);
        }
      )
      .subscribe();
    channelRef.current = channel;

    const safetyPoll = setInterval(refresh, 8000);

    return () => {
      supabase.removeChannel(channel);
      clearInterval(safetyPoll);
    };
  }, [identity]);

  const persistGroup = useCallback(async (updater) => {
    if (!identity) return;
    // re-fetch latest before writing to reduce clobbering concurrent edits
    const latest = (await loadGroup(identity.groupCode)) || group;
    const next = typeof updater === "function" ? updater(latest) : updater;
    setGroup(next);
    await saveGroup(identity.groupCode, next);
    return next;
  }, [identity, group]);

  async function handleCreateGroup({ groupName, yourName, startDate, forfeit }) {
    const code = genCode();
    const memberId = genId();
    const newGroup = {
      code, name: groupName, createdAt: Date.now(),
      startDate, forfeit: forfeit || "",
      members: [{ id: memberId, name: yourName, joinedAt: Date.now() }],
      logs: {}, exemptionRequests: [], timelapseVotes: [],
    };
    const ok = await saveGroup(code, newGroup);
    if (!ok) {
      showToast("Couldn't create the group — check your connection and try again", "error");
      return;
    }
    const id = { memberId, name: yourName, groupCode: code };
    savePersonal("identity", id);
    setIdentity(id);
    setGroup(newGroup);
    showToast(`Group "${groupName}" created — code ${code}`, "success");
  }

  async function handleJoinGroup({ code, yourName }) {
    const upperCode = code.trim().toUpperCase();
    const existing = await loadGroup(upperCode);
    if (!existing) {
      showToast("No group found with that code", "error");
      return false;
    }
    const memberId = genId();
    const next = {
      ...existing,
      members: [...existing.members, { id: memberId, name: yourName, joinedAt: Date.now() }],
    };
    const ok = await saveGroup(upperCode, next);
    if (!ok) {
      showToast("Couldn't join the group — check your connection and try again", "error");
      return false;
    }
    const id = { memberId, name: yourName, groupCode: upperCode };
    savePersonal("identity", id);
    setIdentity(id);
    setGroup(next);
    showToast(`Joined "${existing.name}"`, "success");
    return true;
  }

  function handleLeave() {
    savePersonal("identity", null);
    setIdentity(null);
    setGroup(null);
    setTab("calendar");
  }

  if (booting) {
    return (
      <Shell>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--c-sage)" }}>
          <Loader2 className="spin" size={28} />
        </div>
      </Shell>
    );
  }

  if (!identity || !group) {
    return (
      <Shell>
        <Onboarding onCreate={handleCreateGroup} onJoin={handleJoinGroup} />
      </Shell>
    );
  }

  const me = group.members.find(m => m.id === identity.memberId);

  return (
    <Shell>
      <TopBar group={group} onLeave={handleLeave} showToast={showToast} />
      <div className="screen">
        {tab === "calendar" && <CalendarTab group={group} me={me} persistGroup={persistGroup} showToast={showToast} />}
        {tab === "group" && <GroupTab group={group} me={me} persistGroup={persistGroup} showToast={showToast} />}
        {tab === "votes" && <VotesTab group={group} me={me} persistGroup={persistGroup} showToast={showToast} />}
        {tab === "standings" && <StandingsTab group={group} me={me} />}
      </div>
      <TabBar tab={tab} setTab={setTab} pendingVotes={countOpenVotesRelevantToMe(group, me)} />
      {toast && <Toast toast={toast} />}
    </Shell>
  );
}

function countOpenVotesRelevantToMe(group, me) {
  if (!me) return 0;
  const exemptOpen = (group.exemptionRequests || []).filter(
    e => e.status === "open" && e.memberId !== me.id && !(e.votes && e.votes[me.id])
  ).length;
  const tlOpen = (group.timelapseVotes || []).filter(
    t => t.status === "open" && t.memberId !== me.id && !(t.votes && t.votes[me.id])
  ).length;
  return exemptOpen + tlOpen;
}

/* ============================================================
   SHELL / CHROME
============================================================ */
function Shell({ children }) {
  return (
    <div className="app-root">
      <style>{CSS}</style>
      {children}
    </div>
  );
}

function TopBar({ group, onLeave, showToast }) {
  const [confirmLeave, setConfirmLeave] = useState(false);
  return (
    <div className="topbar">
      <div className="topbar-title">
        <span className="topbar-name">{group.name}</span>
        <button
          className="code-pill"
          onClick={() => {
            navigator.clipboard?.writeText(group.code);
            showToast("Group code copied");
          }}
          title="Copy invite code"
        >
          {group.code} <Copy size={12} />
        </button>
      </div>
      {!confirmLeave ? (
        <button className="icon-btn" onClick={() => setConfirmLeave(true)} title="Leave group">
          <LogOut size={18} />
        </button>
      ) : (
        <div className="leave-confirm">
          <span>Leave?</span>
          <button className="mini-btn danger" onClick={onLeave}>Yes</button>
          <button className="mini-btn" onClick={() => setConfirmLeave(false)}>No</button>
        </div>
      )}
    </div>
  );
}

function TabBar({ tab, setTab, pendingVotes }) {
  const items = [
    { id: "calendar", label: "Calendar", icon: CalIcon },
    { id: "group", label: "Group", icon: Users },
    { id: "votes", label: "Votes", icon: ThumbsUp, badge: pendingVotes },
    { id: "standings", label: "Standings", icon: Trophy },
  ];
  return (
    <div className="tabbar">
      {items.map(it => {
        const Icon = it.icon;
        const active = tab === it.id;
        return (
          <button key={it.id} className={`tab-btn ${active ? "active" : ""}`} onClick={() => setTab(it.id)}>
            <span className="tab-icon-wrap">
              <Icon size={20} strokeWidth={active ? 2.4 : 1.8} />
              {!!it.badge && <span className="badge">{it.badge}</span>}
            </span>
            <span className="tab-label">{it.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Toast({ toast }) {
  return (
    <div className={`toast ${toast.kind}`} key={toast.id}>
      {toast.kind === "error" ? <AlertCircle size={16} /> : toast.kind === "success" ? <Check size={16} /> : null}
      <span>{toast.msg}</span>
    </div>
  );
}

/* ============================================================
   ONBOARDING
============================================================ */
function Onboarding({ onCreate, onJoin }) {
  const [mode, setMode] = useState("landing");
  const [groupName, setGroupName] = useState("");
  const [yourName, setYourName] = useState("");
  const [startDate, setStartDate] = useState(dateStrToday());
  const [forfeit, setForfeit] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [joinName, setJoinName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  if (mode === "landing") {
    return (
      <div className="onboard">
        <div className="onboard-hero">
          <Flame size={36} color="var(--c-amber)" />
          <h1>Summer Study Pact</h1>
          <p>Log your hours. Keep the streak alive. Last place owes a forfeit.</p>
        </div>
        <button className="primary-btn" onClick={() => setMode("create")}>
          <Plus size={18} /> Start a new group
        </button>
        <button className="secondary-btn" onClick={() => setMode("join")}>
          Join with a code
        </button>
        <div className="onboard-rules">
          <RuleLine icon={Clock} text="Set your own hours-per-day and deadline once you create or join a group" />
          <RuleLine icon={Flame} text="Miss the deadline → 1 point. Most points at the end loses." />
          <RuleLine icon={ThumbsUp} text="Exemptions & timelapse proof are decided by group vote" />
        </div>
      </div>
    );
  }

  if (mode === "create") {
    return (
      <div className="onboard">
        <button className="back-link" onClick={() => setMode("landing")}><ChevronLeft size={16} /> Back</button>
        <h2>Start a group</h2>
        <Field label="Group name">
          <input value={groupName} onChange={e => setGroupName(e.target.value)} placeholder="e.g. The Library Lurkers" />
        </Field>
        <Field label="Your name">
          <input value={yourName} onChange={e => setYourName(e.target.value)} placeholder="e.g. Sam" />
        </Field>
        <Field label="Start date">
          <input type="date" value={startDate} onChange={e => setStartDate(e.target.value)} />
        </Field>
        <Field label="Loser's forfeit (shown to everyone, optional)">
          <textarea value={forfeit} onChange={e => setForfeit(e.target.value)} placeholder="e.g. Buys boba for the group, wears a cone of shame in the group photo..." rows={3} />
        </Field>
        <button
          className="primary-btn"
          disabled={!groupName.trim() || !yourName.trim() || busy}
          onClick={async () => {
            setBusy(true);
            await onCreate({ groupName: groupName.trim(), yourName: yourName.trim(), startDate, forfeit: forfeit.trim() });
            setBusy(false);
          }}
        >
          {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />} Create group
        </button>
      </div>
    );
  }

  return (
    <div className="onboard">
      <button className="back-link" onClick={() => setMode("landing")}><ChevronLeft size={16} /> Back</button>
      <h2>Join a group</h2>
      <Field label="Invite code">
        <input
          value={joinCode}
          onChange={e => setJoinCode(e.target.value.toUpperCase())}
          placeholder="e.g. K7H2Q"
          maxLength={8}
          style={{ letterSpacing: "0.15em", fontFamily: "var(--font-mono)" }}
        />
      </Field>
      <Field label="Your name">
        <input value={joinName} onChange={e => setJoinName(e.target.value)} placeholder="e.g. Sam" />
      </Field>
      {err && <div className="inline-error"><AlertCircle size={14} /> {err}</div>}
      <button
        className="primary-btn"
        disabled={!joinCode.trim() || !joinName.trim() || busy}
        onClick={async () => {
          setBusy(true);
          setErr("");
          const ok = await onJoin({ code: joinCode, yourName: joinName.trim() });
          setBusy(false);
          if (!ok) setErr("No group found with that code.");
        }}
      >
        {busy ? <Loader2 size={16} className="spin" /> : <Users size={16} />} Join group
      </button>
    </div>
  );
}

function RuleLine({ icon: Icon, text }) {
  return (
    <div className="rule-line">
      <Icon size={15} />
      <span>{text}</span>
    </div>
  );
}

function Field({ label, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

/* ============================================================
   CALENDAR TAB (wraps individual + group calendar views)
============================================================ */
function CalendarTab({ group, me, persistGroup, showToast }) {
  const [view, setView] = useState("mine"); // "mine" | "group"
  return (
    <div className="tab-content">
      <div className="seg-control cal-view-toggle">
        <button className={view === "mine" ? "active" : ""} onClick={() => setView("mine")}>My calendar</button>
        <button className={view === "group" ? "active" : ""} onClick={() => setView("group")}>Group calendar</button>
      </div>
      {view === "mine" ? (
        <IndividualCalendarView group={group} me={me} persistGroup={persistGroup} showToast={showToast} />
      ) : (
        <GroupCalendarView group={group} me={me} />
      )}
    </div>
  );
}

function IndividualCalendarView({ group, me, persistGroup, showToast }) {
  const [viewMonth, setViewMonth] = useState(dateStrToday().slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(dateStrToday());
  const [viewMemberId, setViewMemberId] = useState(me.id);

  const today = dateStrToday();
  const startDate = group.startDate || today;

  const days = useMemo(() => {
    const [y, m] = viewMonth.split("-").map(Number);
    const first = `${viewMonth}-01`;
    const firstDow = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
    const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const cells = [];
    for (let i = 0; i < firstDow; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      cells.push(`${viewMonth}-${String(d).padStart(2, "0")}`);
    }
    return cells;
  }, [viewMonth]);

  const viewMember = group.members.find(m => m.id === viewMemberId) || me;

  const monthStats = useMemo(() => {
    let met = 0, missed = 0, exempt = 0;
    days.forEach(d => {
      if (!d || d < startDate || d > today) return;
      const s = computeDayStatus(group, d, viewMemberId).status;
      if (s === STATUS.MET) met++;
      else if (s === STATUS.MISSED) missed++;
      else if (s === STATUS.EXEMPT_FULL || s === STATUS.EXEMPT_PARTIAL) exempt++;
    });
    return { met, missed, exempt };
  }, [days, group, viewMemberId, startDate, today]);

  const streak = useMemo(() => computeStreak(group, viewMemberId, startDate, today), [group, viewMemberId, startDate, today]);

  return (
    <div className="cal-view-section">
      <div className="member-switcher">
        {group.members.map(m => (
          <button
            key={m.id}
            className={`chip ${m.id === viewMemberId ? "active" : ""}`}
            onClick={() => setViewMemberId(m.id)}
          >
            {m.id === me.id ? "You" : m.name}
          </button>
        ))}
      </div>

      <div className="streak-banner">
        <div className="streak-num">
          <Flame size={22} color={streak > 0 ? "var(--c-amber)" : "var(--c-sage)"} />
          <span>{streak}</span>
        </div>
        <span className="streak-label">day streak</span>
        <div className="month-stats">
          <StatChip color="var(--c-green)" n={monthStats.met} label="met" />
          <StatChip color="var(--c-red)" n={monthStats.missed} label="missed" />
          <StatChip color="var(--c-amber)" n={monthStats.exempt} label="exempt" />
        </div>
      </div>

      <div className="month-nav">
        <button className="icon-btn" onClick={() => setViewMonth(shiftMonth(viewMonth, -1))}><ChevronLeft size={18} /></button>
        <span className="month-label">{monthLabel(viewMonth + "-01")}</span>
        <button className="icon-btn" onClick={() => setViewMonth(shiftMonth(viewMonth, 1))}><ChevronRight size={18} /></button>
      </div>

      <div className="cal-grid">
        {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => (
          <div key={i} className="cal-dow">{d}</div>
        ))}
        {days.map((d, i) => {
          if (!d) return <div key={i} className="cal-cell empty" />;
          const beforeStart = d < startDate;
          const result = computeDayStatus(group, d, viewMemberId);
          const style = STATUS_STYLE[result.status];
          const isToday = d === today;
          const isSelected = d === selectedDate;
          const pts = pointsForStatus(result.status);
          return (
            <button
              key={i}
              className={`cal-cell ${isToday ? "today" : ""} ${isSelected ? "selected" : ""} ${beforeStart ? "before-start" : ""}`}
              style={!beforeStart ? { background: style.bg, color: style.fg } : undefined}
              onClick={() => setSelectedDate(d)}
            >
              <span className="cal-daynum">{parseInt(d.slice(8), 10)}</span>
              {!beforeStart && pts > 0 && <span className="cal-pt-stamp">+{pts}</span>}
            </button>
          );
        })}
      </div>

      <DayDetail
        date={selectedDate}
        group={group}
        me={me}
        viewMember={viewMember}
        persistGroup={persistGroup}
        showToast={showToast}
        startDate={startDate}
      />
    </div>
  );
}

function StatChip({ color, n, label }) {
  return (
    <div className="stat-chip">
      <span className="stat-dot" style={{ background: color }} />
      <span>{n} {label}</span>
    </div>
  );
}

/* ============================================================
   GROUP CALENDAR VIEW — everyone's status at once
============================================================ */
function GroupCalendarView({ group, me }) {
  const [viewMonth, setViewMonth] = useState(dateStrToday().slice(0, 7));
  const [selectedDate, setSelectedDate] = useState(dateStrToday());
  const today = dateStrToday();
  const startDate = group.startDate || today;

  const daysInMonth = useMemo(() => {
    const [y, m] = viewMonth.split("-").map(Number);
    const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const out = [];
    for (let d = 1; d <= n; d++) out.push(`${viewMonth}-${String(d).padStart(2, "0")}`);
    return out;
  }, [viewMonth]);

  return (
    <div className="cal-view-section">
      <div className="month-nav">
        <button className="icon-btn" onClick={() => setViewMonth(shiftMonth(viewMonth, -1))}><ChevronLeft size={18} /></button>
        <span className="month-label">{monthLabel(viewMonth + "-01")}</span>
        <button className="icon-btn" onClick={() => setViewMonth(shiftMonth(viewMonth, 1))}><ChevronRight size={18} /></button>
      </div>

      <div className="group-cal-legend">
        {group.members.map(m => (
          <span key={m.id} className="group-cal-legend-item">
            <span className="member-avatar tiny">{m.name.slice(0, 1).toUpperCase()}</span>
            {m.id === me.id ? "You" : m.name}
          </span>
        ))}
      </div>

      <div className="group-cal-list">
        {daysInMonth.map(d => {
          const beforeStart = d < startDate;
          const isFuture = d > today;
          const isToday = d === today;
          const isSelected = d === selectedDate;
          if (beforeStart) return null;
          return (
            <button
              key={d}
              className={`group-cal-row ${isToday ? "today" : ""} ${isSelected ? "selected" : ""}`}
              onClick={() => setSelectedDate(d)}
            >
              <span className="group-cal-row-date">
                <span className="group-cal-row-dow">{fmtDateLong(d).slice(0, 3)}</span>
                <span className="group-cal-row-num">{parseInt(d.slice(8), 10)}</span>
              </span>
              <span className="group-cal-row-dots">
                {group.members.map(m => {
                  if (isFuture) return <span key={m.id} className="group-dot future" title={m.name} />;
                  const result = computeDayStatus(group, d, m.id);
                  const style = STATUS_STYLE[result.status];
                  return (
                    <span
                      key={m.id}
                      className="group-dot"
                      style={{ background: style.bg }}
                      title={`${m.name}: ${style.label}`}
                    />
                  );
                })}
              </span>
            </button>
          );
        })}
      </div>

      <GroupDayBreakdown date={selectedDate} group={group} me={me} startDate={startDate} />
    </div>
  );
}

function GroupDayBreakdown({ date, group, me, startDate }) {
  if (date < startDate) return null;
  const today = dateStrToday();
  return (
    <div className="day-detail">
      <div className="day-detail-head">
        <span className="day-detail-date">{fmtDateLong(date)}</span>
        {date > today && <span className="status-pill" style={{ background: "var(--c-future)", color: "var(--c-sage)" }}>Upcoming</span>}
      </div>
      <div className="group-breakdown-list">
        {group.members.map(m => {
          const result = computeDayStatus(group, date, m.id);
          const style = STATUS_STYLE[result.status];
          return (
            <div key={m.id} className="group-breakdown-row">
              <span className="member-avatar tiny">{m.name.slice(0, 1).toUpperCase()}</span>
              <span className="group-breakdown-name">{m.id === me.id ? "You" : m.name}</span>
              <span className="group-breakdown-hours">{result.hoursLogged}h / {result.required}h</span>
              <span className="status-pill small" style={{ background: style.bg, color: style.fg }}>{style.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function shiftMonth(ym, delta) {
  const [y, m] = ym.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}`;
}

function computeStreak(group, memberId, startDate, today) {
  let streak = 0;
  let d = today;
  // if today is still pending/future and not yet met, start checking from yesterday
  const todayStatus = computeDayStatus(group, today, memberId).status;
  if (todayStatus === STATUS.PENDING || todayStatus === STATUS.FUTURE) {
    d = addDays(today, -1);
  }
  while (d >= startDate) {
    const s = computeDayStatus(group, d, memberId).status;
    if (s === STATUS.MET || s === STATUS.EXEMPT_FULL || s === STATUS.EXEMPT_PARTIAL) {
      streak++;
      d = addDays(d, -1);
    } else {
      break;
    }
  }
  return streak;
}

/* ============================================================
   DAY DETAIL PANEL (log hours, view status, request exemption, submit timelapse)
============================================================ */
function DayDetail({ date, group, me, viewMember, persistGroup, showToast, startDate }) {
  const isMe = viewMember.id === me.id;
  const result = computeDayStatus(group, date, viewMember.id);
  const style = STATUS_STYLE[result.status];
  const [hoursInput, setHoursInput] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [showExemptForm, setShowExemptForm] = useState(false);
  const [showTimelapseForm, setShowTimelapseForm] = useState(false);
  const [saving, setSaving] = useState(false);

  const existingLog = group.logs?.[date]?.[viewMember.id];
  const pastDeadline = isPastDeadline(date, getSettings(group));
  const beforeStart = date < startDate;

  useEffect(() => {
    setHoursInput(existingLog?.hours ? String(existingLog.hours) : "");
    setNoteInput(existingLog?.note || "");
    setShowExemptForm(false);
    setShowTimelapseForm(false);
  }, [date, viewMember.id, existingLog?.hours, existingLog?.note]);

  async function saveLog() {
    const hours = parseFloat(hoursInput);
    if (isNaN(hours) || hours < 0) {
      showToast("Enter a valid number of hours", "error");
      return;
    }
    setSaving(true);
    await persistGroup(g => ({
      ...g,
      logs: {
        ...g.logs,
        [date]: {
          ...(g.logs[date] || {}),
          [me.id]: { ...(g.logs[date]?.[me.id] || {}), hours, note: noteInput, loggedAt: Date.now() },
        },
      },
    }));
    setSaving(false);
    showToast("Hours logged");
  }

  if (beforeStart) {
    return (
      <div className="day-detail">
        <div className="day-detail-head">
          <span className="day-detail-date">{fmtDateLong(date)}</span>
        </div>
        <p className="muted-note">This is before the group's start date.</p>
      </div>
    );
  }

  return (
    <div className="day-detail">
      <div className="day-detail-head">
        <span className="day-detail-date">{fmtDateLong(date)}</span>
        <span className="status-pill" style={{ background: style.bg, color: style.fg }}>{style.label}</span>
      </div>

      <div className="day-detail-req">
        <Clock size={14} />
        <span>{result.required}h required · due {fmtDeadline(getSettings(group))}{!isMe ? ` · viewing ${viewMember.name}` : ""}</span>
      </div>

      {result.exemption && (
        <div className="exemption-note">
          <Check size={13} />
          {result.exemption.type === "full" ? "Full-day exemption granted" : `Partial exemption granted (−${result.exemption.partialHours}h)`}
        </div>
      )}

      {isMe && !pastDeadline && (
        <div className="log-form">
          <Field label="Hours studied today">
            <input
              type="number" min="0" step="0.25" inputMode="decimal"
              value={hoursInput} onChange={e => setHoursInput(e.target.value)}
              placeholder="0"
            />
          </Field>
          <Field label="Note (optional)">
            <input value={noteInput} onChange={e => setNoteInput(e.target.value)} placeholder="What'd you study?" />
          </Field>
          <button className="primary-btn" onClick={saveLog} disabled={saving}>
            {saving ? <Loader2 size={15} className="spin" /> : <Check size={15} />} Save hours
          </button>
        </div>
      )}

      {isMe && pastDeadline && existingLog && (
        <div className="logged-summary">
          Logged {existingLog.hours}h{existingLog.note ? ` — "${existingLog.note}"` : ""}
        </div>
      )}

      <TimelapseList group={group} date={date} memberId={viewMember.id} />

      {isMe && (
        <div className="day-actions">
          {result.status === STATUS.MISSED && (
            <button className="action-btn" onClick={() => setShowExemptForm(s => !s)}>
              <AlertCircle size={14} /> Request exemption
            </button>
          )}
          <button className="action-btn" onClick={() => setShowTimelapseForm(s => !s)}>
            <Video size={14} /> Add timelapse
          </button>
        </div>
      )}

      {showExemptForm && (
        <ExemptionRequestForm
          date={date} me={me} group={group} persistGroup={persistGroup} showToast={showToast}
          onDone={() => setShowExemptForm(false)}
        />
      )}

      {showTimelapseForm && (
        <TimelapseSubmitForm
          date={date} me={me} group={group} persistGroup={persistGroup} showToast={showToast}
          onDone={() => setShowTimelapseForm(false)}
        />
      )}
    </div>
  );
}

function TimelapseList({ group, date, memberId }) {
  const votes = (group.timelapseVotes || [])
    .filter(v => v.memberId === memberId && v.date === date)
    .sort((a, b) => a.createdAt - b.createdAt);
  if (votes.length === 0) return null;
  const total = group.members.length - 1;
  const threshold = getSettings(group).voteThreshold;
  return (
    <div className="timelapse-list">
      {votes.map((vote, i) => {
        const tally = tallyVotes(vote.votes, total, threshold);
        return (
          <div className="timelapse-card" key={vote.id}>
            <Video size={14} />
            <div className="timelapse-card-body">
              <a href={vote.url} target="_blank" rel="noopener noreferrer">
                {vote.label || `Clip ${i + 1}`}
              </a>
              <span className={`tl-status ${vote.status}`}>
                {vote.status === "open" ? `Voting: ${tally.yes} yes / ${tally.no} no (needs ${tally.needed})` :
                 vote.status === "counted" ? "Counted as studying ✓" : "Group voted: doesn't count"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ============================================================
   EXEMPTION REQUEST FORM
============================================================ */
function ExemptionRequestForm({ date, me, group, persistGroup, showToast, onDone }) {
  const [type, setType] = useState("full");
  const [partialHours, setPartialHours] = useState("1");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason.trim()) {
      showToast("Add a short reason", "error");
      return;
    }
    setBusy(true);
    await persistGroup(g => ({
      ...g,
      exemptionRequests: [
        ...g.exemptionRequests,
        {
          id: genId(), memberId: me.id, date, type,
          partialHours: type === "partial" ? parseFloat(partialHours) || 0 : 0,
          reason: reason.trim(), votes: {}, status: "open", createdAt: Date.now(),
        },
      ],
    }));
    setBusy(false);
    showToast("Exemption request submitted for vote");
    onDone();
  }

  return (
    <div className="sub-form">
      <div className="seg-control">
        <button className={type === "full" ? "active" : ""} onClick={() => setType("full")}>Full day</button>
        <button className={type === "partial" ? "active" : ""} onClick={() => setType("partial")}>Partial</button>
      </div>
      {type === "partial" && (
        <Field label="Hours to excuse">
          <input type="number" min="0.5" step="0.5" value={partialHours} onChange={e => setPartialHours(e.target.value)} />
        </Field>
      )}
      <Field label="Reason for the group">
        <textarea rows={2} value={reason} onChange={e => setReason(e.target.value)} placeholder="e.g. Family thing all day, traveling, sick..." />
      </Field>
      <button className="primary-btn" onClick={submit} disabled={busy}>
        {busy ? <Loader2 size={15} className="spin" /> : <ThumbsUp size={15} />} Send to group vote
      </button>
    </div>
  );
}

/* ============================================================
   TIMELAPSE SUBMIT FORM
============================================================ */
function TimelapseSubmitForm({ date, me, group, persistGroup, showToast, onDone }) {
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!url.trim() || !/^https?:\/\//i.test(url.trim())) {
      showToast("Enter a valid link starting with http(s)://", "error");
      return;
    }
    setBusy(true);
    await persistGroup(g => ({
      ...g,
      timelapseVotes: [
        ...(g.timelapseVotes || []),
        {
          id: genId(), memberId: me.id, date, url: url.trim(),
          label: label.trim(), votes: {}, status: "open", createdAt: Date.now(),
        },
      ],
    }));
    setBusy(false);
    showToast("Timelapse submitted — group will vote");
    setUrl("");
    setLabel("");
    onDone();
  }

  return (
    <div className="sub-form">
      <Field label="Timelapse link (Drive, YouTube, etc.)">
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder="https://..." />
      </Field>
      <Field label="Label (optional — e.g. 'morning session')">
        <input value={label} onChange={e => setLabel(e.target.value)} placeholder="Morning session" />
      </Field>
      <p className="muted-note small">
        You can add more than one clip for the same day. Your group will watch each link and vote on whether it counts as real study time.
      </p>
      <button className="primary-btn" onClick={submit} disabled={busy}>
        {busy ? <Loader2 size={15} className="spin" /> : <Video size={15} />} Submit for vote
      </button>
    </div>
  );
}

/* ============================================================
   GROUP TAB
============================================================ */
function GroupTab({ group, me, persistGroup, showToast }) {
  const [editingForfeit, setEditingForfeit] = useState(false);
  const [forfeitText, setForfeitText] = useState(group.forfeit || "");
  const [editingSettings, setEditingSettings] = useState(false);
  const settings = getSettings(group);
  const [draft, setDraft] = useState(settings);

  const today = dateStrToday();

  function openSettingsEditor() {
    setDraft(getSettings(group));
    setEditingSettings(true);
  }

  async function saveSettings() {
    const clean = {
      weekdayHours: clampHours(draft.weekdayHours),
      weekendHours: clampHours(draft.weekendHours),
      deadlineHour: clampInt(draft.deadlineHour, 0, 23),
      deadlineMin: clampInt(draft.deadlineMin, 0, 59),
      voteThreshold: draft.voteThreshold === "unanimous" ? "unanimous" : "majority",
    };
    await persistGroup(g => ({ ...g, settings: clean }));
    setEditingSettings(false);
    showToast("Group settings updated for everyone");
  }

  return (
    <div className="tab-content">
      <SectionTitle>Invite friends</SectionTitle>
      <div className="invite-card">
        <span>Share this code:</span>
        <button
          className="code-pill big"
          onClick={() => { navigator.clipboard?.writeText(group.code); showToast("Code copied"); }}
        >
          {group.code} <Copy size={14} />
        </button>
      </div>

      <SectionTitle>Members ({group.members.length})</SectionTitle>
      <div className="member-list">
        {group.members.map(m => {
          const points = totalPoints(group, m.id, group.startDate, today);
          return (
            <div key={m.id} className="member-row">
              <span className="member-avatar">{m.name.slice(0, 1).toUpperCase()}</span>
              <span className="member-name">{m.name}{m.id === me.id ? " (you)" : ""}</span>
              <span className="member-points">{points} pt{points === 1 ? "" : "s"}</span>
            </div>
          );
        })}
      </div>

      <SectionTitle>Group settings</SectionTitle>
      {!editingSettings ? (
        <div className="rules-card editable" onClick={openSettingsEditor}>
          <RuleLine icon={Clock} text={`${settings.weekdayHours}h weekdays, ${settings.weekendHours}h weekends — due ${fmtDeadline(settings)}`} />
          <RuleLine icon={Flame} text="Miss a deadline → +1 point. Most points when it ends, loses." />
          <RuleLine icon={ThumbsUp} text={`Exemptions and timelapse proof require a ${settings.voteThreshold === "unanimous" ? "unanimous" : "majority"} group vote`} />
          <RuleLine icon={CalIcon} text={`Tracking since ${fmtDateLong(group.startDate)}`} />
          <span className="tap-to-edit">Tap to edit — changes apply for everyone</span>
        </div>
      ) : (
        <div className="sub-form">
          <div className="settings-grid">
            <Field label="Weekday hours">
              <input type="number" min="0" step="0.5" value={draft.weekdayHours}
                onChange={e => setDraft(d => ({ ...d, weekdayHours: e.target.value }))} />
            </Field>
            <Field label="Weekend hours">
              <input type="number" min="0" step="0.5" value={draft.weekendHours}
                onChange={e => setDraft(d => ({ ...d, weekendHours: e.target.value }))} />
            </Field>
          </div>
          <div className="settings-grid">
            <Field label="Deadline hour (0–23, ET)">
              <input type="number" min="0" max="23" value={draft.deadlineHour}
                onChange={e => setDraft(d => ({ ...d, deadlineHour: e.target.value }))} />
            </Field>
            <Field label="Deadline minute">
              <input type="number" min="0" max="59" value={draft.deadlineMin}
                onChange={e => setDraft(d => ({ ...d, deadlineMin: e.target.value }))} />
            </Field>
          </div>
          <p className="muted-note small">Preview: due {fmtDeadline(draft)}</p>
          <Field label="Vote rule for exemptions & timelapses">
            <div className="seg-control">
              <button className={draft.voteThreshold !== "unanimous" ? "active" : ""} onClick={() => setDraft(d => ({ ...d, voteThreshold: "majority" }))}>Majority</button>
              <button className={draft.voteThreshold === "unanimous" ? "active" : ""} onClick={() => setDraft(d => ({ ...d, voteThreshold: "unanimous" }))}>Unanimous</button>
            </div>
          </Field>
          <p className="muted-note small">
            This changes the rules for the whole group — existing logged days are recalculated against the new hours and deadline automatically.
          </p>
          <div className="form-row-btns">
            <button className="primary-btn" onClick={saveSettings}>Save for everyone</button>
            <button className="secondary-btn" onClick={() => setEditingSettings(false)}>Cancel</button>
          </div>
        </div>
      )}

      <SectionTitle>Loser's forfeit</SectionTitle>
      {!editingForfeit ? (
        <div className="forfeit-card" onClick={() => setEditingForfeit(true)}>
          <Skull size={16} color="var(--c-red)" />
          <span>{group.forfeit ? group.forfeit : "No forfeit set yet — tap to add one"}</span>
        </div>
      ) : (
        <div className="sub-form">
          <textarea rows={3} value={forfeitText} onChange={e => setForfeitText(e.target.value)} placeholder="What does the loser have to do?" />
          <div className="form-row-btns">
            <button className="primary-btn" onClick={async () => {
              await persistGroup(g => ({ ...g, forfeit: forfeitText.trim() }));
              setEditingForfeit(false);
              showToast("Forfeit updated");
            }}>Save</button>
            <button className="secondary-btn" onClick={() => { setEditingForfeit(false); setForfeitText(group.forfeit || ""); }}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

function clampHours(v) {
  const n = parseFloat(v);
  if (isNaN(n) || n < 0) return 0;
  return Math.min(n, 24);
}
function clampInt(v, min, max) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function SectionTitle({ children }) {
  return <div className="section-title">{children}</div>;
}

function totalPoints(group, memberId, startDate, today) {
  let pts = 0;
  let d = startDate;
  while (d <= today) {
    const s = computeDayStatus(group, d, memberId).status;
    pts += pointsForStatus(s);
    d = addDays(d, 1);
  }
  return pts;
}

/* ============================================================
   VOTES TAB
============================================================ */
function VotesTab({ group, me, persistGroup, showToast }) {
  const others = group.members.length - 1;
  const voteThreshold = getSettings(group).voteThreshold;
  const exemptions = [...(group.exemptionRequests || [])].sort((a, b) => b.createdAt - a.createdAt);
  const timelapses = [...(group.timelapseVotes || [])].sort((a, b) => b.createdAt - a.createdAt);

  async function castExemptionVote(reqId, vote) {
    await persistGroup(g => ({
      ...g,
      exemptionRequests: g.exemptionRequests.map(r => {
        if (r.id !== reqId) return r;
        const votes = { ...r.votes, [me.id]: vote };
        const tally = tallyVotes(votes, others, getSettings(g).voteThreshold);
        let status = r.status;
        if (tally.passed) status = "granted";
        return { ...r, votes, status };
      }),
    }));
    showToast(vote === "yes" ? "Voted yes" : "Voted no");
  }

  async function castTimelapseVote(voteId, vote) {
    await persistGroup(g => ({
      ...g,
      timelapseVotes: g.timelapseVotes.map(v => {
        if (v.id !== voteId) return v;
        const votes = { ...v.votes, [me.id]: vote };
        const tally = tallyVotes(votes, others, getSettings(g).voteThreshold);
        let status = v.status;
        if (tally.passed) status = "counted";
        return { ...v, votes, status };
      }),
    }));
    showToast(vote === "yes" ? "Voted yes" : "Voted no");
  }

  const hasAny = exemptions.length > 0 || timelapses.length > 0;

  return (
    <div className="tab-content">
      {!hasAny && (
        <EmptyState icon={ThumbsUp} text="No requests yet" sub="Exemption requests and timelapse submissions will show up here for the group to vote on." />
      )}

      {exemptions.length > 0 && <SectionTitle>Exemption requests</SectionTitle>}
      {exemptions.map(req => {
        const member = group.members.find(m => m.id === req.memberId);
        const tally = tallyVotes(req.votes, others, voteThreshold);
        const myVote = req.votes?.[me.id];
        const isMine = req.memberId === me.id;
        return (
          <div key={req.id} className="vote-card">
            <div className="vote-card-head">
              <span className="vote-card-who">{isMine ? "You" : member?.name}</span>
              <span className="vote-card-date">{fmtDateLong(req.date)}</span>
              <VoteStatusBadge status={req.status} />
            </div>
            <p className="vote-card-detail">
              {req.type === "full" ? "Requesting full-day exemption" : `Requesting ${req.partialHours}h excused`}
            </p>
            <p className="vote-card-reason">"{req.reason}"</p>
            {req.status === "open" && !isMine && (
              <VoteButtons myVote={myVote} onVote={v => castExemptionVote(req.id, v)} />
            )}
            <VoteTally tally={tally} />
          </div>
        );
      })}

      {timelapses.length > 0 && <SectionTitle>Timelapse submissions</SectionTitle>}
      {timelapses.map(tl => {
        const member = group.members.find(m => m.id === tl.memberId);
        const tally = tallyVotes(tl.votes, others, voteThreshold);
        const myVote = tl.votes?.[me.id];
        const isMine = tl.memberId === me.id;
        return (
          <div key={tl.id} className="vote-card">
            <div className="vote-card-head">
              <span className="vote-card-who">{isMine ? "You" : member?.name}</span>
              <span className="vote-card-date">{fmtDateLong(tl.date)}</span>
              <VoteStatusBadge status={tl.status === "counted" ? "granted" : tl.status === "rejected" ? "denied" : "open"} />
            </div>
            <a className="vote-card-link" href={tl.url} target="_blank" rel="noopener noreferrer">
              <Video size={13} /> Watch timelapse
            </a>
            {tl.status === "open" && !isMine && (
              <VoteButtons myVote={myVote} onVote={v => castTimelapseVote(tl.id, v)} label={["Counts as studying", "Doesn't count"]} />
            )}
            <VoteTally tally={tally} />
          </div>
        );
      })}
    </div>
  );
}

function VoteStatusBadge({ status }) {
  if (status === "open") return <span className="vote-badge open">Open</span>;
  if (status === "granted") return <span className="vote-badge granted">Granted</span>;
  return <span className="vote-badge denied">Denied</span>;
}

function VoteButtons({ myVote, onVote, label = ["Yes", "No"] }) {
  return (
    <div className="vote-buttons">
      <button className={`vote-btn yes ${myVote === "yes" ? "selected" : ""}`} onClick={() => onVote("yes")}>
        <ThumbsUp size={14} /> {label[0]}
      </button>
      <button className={`vote-btn no ${myVote === "no" ? "selected" : ""}`} onClick={() => onVote("no")}>
        <ThumbsDown size={14} /> {label[1]}
      </button>
    </div>
  );
}

function VoteTally({ tally }) {
  return (
    <div className="vote-tally">
      <div className="vote-tally-bar">
        <div className="vote-tally-fill" style={{ width: `${Math.min(100, (tally.yes / Math.max(1, tally.needed)) * 100)}%` }} />
      </div>
      <span>{tally.yes} yes · {tally.no} no · needs {tally.needed} to pass</span>
    </div>
  );
}

function EmptyState({ icon: Icon, text, sub }) {
  return (
    <div className="empty-state">
      <Icon size={28} color="var(--c-sage)" />
      <span className="empty-text">{text}</span>
      {sub && <span className="empty-sub">{sub}</span>}
    </div>
  );
}

/* ============================================================
   STANDINGS TAB
============================================================ */
function StandingsTab({ group, me }) {
  const today = dateStrToday();
  const standings = useMemo(() => {
    return group.members
      .map(m => ({ ...m, points: totalPoints(group, m.id, group.startDate, today), streak: computeStreak(group, m.id, group.startDate, today) }))
      .sort((a, b) => a.points - b.points || b.streak - a.streak);
  }, [group, today]);

  const maxPoints = Math.max(...standings.map(s => s.points), 1);
  const currentLoser = [...standings].sort((a, b) => b.points - a.points)[0];

  return (
    <div className="tab-content">
      <SectionTitle>Standings</SectionTitle>
      <p className="muted-note small" style={{ marginBottom: 14 }}>
        Points are bad — they stack up every time you miss the deadline. Fewest points wins.
      </p>

      <div className="standings-list">
        {standings.map((s, i) => (
          <div key={s.id} className={`standing-row ${s.id === me.id ? "me" : ""}`}>
            <span className="standing-rank">{i + 1}</span>
            <span className="member-avatar">{s.name.slice(0, 1).toUpperCase()}</span>
            <div className="standing-mid">
              <span className="standing-name">{s.name}{s.id === me.id ? " (you)" : ""}</span>
              <div className="standing-bar-track">
                <div className="standing-bar-fill" style={{ width: `${(s.points / maxPoints) * 100}%` }} />
              </div>
            </div>
            <span className="standing-pts">{s.points}</span>
            {s.streak > 0 && (
              <span className="standing-streak"><Flame size={12} color="var(--c-amber)" />{s.streak}</span>
            )}
          </div>
        ))}
      </div>

      {group.forfeit && currentLoser && currentLoser.points > 0 && (
        <div className="loser-card">
          <Skull size={18} color="var(--c-red)" />
          <div>
            <span className="loser-card-title">Currently in last: {currentLoser.name}</span>
            <span className="loser-card-forfeit">If it ends today: {group.forfeit}</span>
          </div>
        </div>
      )}

      {standings.every(s => s.points === 0) && (
        <div className="all-clean-card">
          <PartyPopper size={18} color="var(--c-green)" />
          <span>Everyone's clean so far. Keep it that way.</span>
        </div>
      )}
    </div>
  );
}

/* ============================================================
   CSS
============================================================ */
const CSS = `
:root {
  --c-bg: #0B1426;
  --c-cream: #EAF1FB;
  --c-green: #36D6A8;
  --c-red: #E2483D;
  --c-amber: #E8B339;
  --c-sage: #7187A8;
  --c-ink: #0B1426;
  --c-pending: #28406B;
  --c-future: #111E36;
  --c-card: #14213B;
  --c-card-border: #233E63;
  --c-accent: #3D8BFF;
  --font-display: 'Archivo Expanded', 'Arial Narrow', sans-serif;
  --font-body: 'Inter', -apple-system, system-ui, sans-serif;
  --font-mono: 'JetBrains Mono', 'Courier New', monospace;
}

* { box-sizing: border-box; }

.app-root {
  width: 100%;
  max-width: 480px;
  margin: 0 auto;
  min-height: 600px;
  height: 100%;
  background: var(--c-bg);
  color: var(--c-cream);
  font-family: var(--font-body);
  display: flex;
  flex-direction: column;
  position: relative;
  overflow: hidden;
  border-radius: 18px;
}

.spin { animation: spin 0.9s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ---------- TOPBAR ---------- */
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 16px 12px;
  border-bottom: 1px solid var(--c-card-border);
  flex-shrink: 0;
}
.topbar-title { display: flex; align-items: center; gap: 10px; min-width: 0; }
.topbar-name { font-family: var(--font-display); font-weight: 700; font-size: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 160px; }
.code-pill {
  background: var(--c-card); border: 1px solid var(--c-card-border); color: var(--c-sage);
  font-family: var(--font-mono); font-size: 11px; padding: 4px 8px; border-radius: 20px;
  display: inline-flex; align-items: center; gap: 5px; cursor: pointer; letter-spacing: 0.05em;
}
.code-pill.big { font-size: 15px; padding: 8px 14px; color: var(--c-cream); }
.icon-btn { background: transparent; border: none; color: var(--c-sage); cursor: pointer; padding: 6px; display: flex; }
.icon-btn:hover { color: var(--c-cream); }
.leave-confirm { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--c-sage); }
.mini-btn { background: var(--c-card); border: 1px solid var(--c-card-border); color: var(--c-cream); border-radius: 8px; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.mini-btn.danger { background: var(--c-red); border-color: var(--c-red); color: var(--c-cream); }

/* ---------- SCREEN / TABS ---------- */
.screen { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }
.tab-content { padding: 16px; padding-bottom: 90px; }

.tabbar {
  position: absolute; bottom: 0; left: 0; right: 0;
  display: flex; background: #08101F; border-top: 1px solid var(--c-card-border);
  padding: 6px 4px calc(env(safe-area-inset-bottom, 0px) + 6px);
}
.tab-btn {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 3px;
  background: transparent; border: none; color: var(--c-sage); padding: 8px 2px; cursor: pointer;
  border-radius: 12px;
}
.tab-btn.active { color: var(--c-accent); }
.tab-label { font-size: 10.5px; font-weight: 600; }
.tab-icon-wrap { position: relative; }
.badge {
  position: absolute; top: -4px; right: -8px; background: var(--c-red); color: var(--c-cream);
  font-size: 9px; font-weight: 700; border-radius: 8px; min-width: 15px; height: 15px;
  display: flex; align-items: center; justify-content: center; padding: 0 3px;
}

/* ---------- ONBOARDING ---------- */
.onboard { padding: 28px 22px; display: flex; flex-direction: column; gap: 14px; height: 100%; }
.onboard-hero { text-align: center; padding: 30px 0 10px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.onboard-hero h1 { font-family: var(--font-display); font-size: 26px; margin: 0; letter-spacing: -0.01em; }
.onboard-hero p { color: var(--c-sage); font-size: 14px; margin: 0; max-width: 280px; }
.onboard-rules { margin-top: 20px; display: flex; flex-direction: column; gap: 12px; background: var(--c-card); border: 1px solid var(--c-card-border); border-radius: 14px; padding: 16px; }
.rule-line { display: flex; align-items: flex-start; gap: 10px; font-size: 13px; color: var(--c-cream); }
.rule-line svg { flex-shrink: 0; margin-top: 1px; color: var(--c-amber); }
.back-link { background: none; border: none; color: var(--c-sage); display: flex; align-items: center; gap: 4px; cursor: pointer; padding: 0; font-size: 13px; align-self: flex-start; }
.onboard h2 { font-family: var(--font-display); font-size: 20px; margin: 4px 0 6px; }

.field { display: flex; flex-direction: column; gap: 6px; }
.field-label { font-size: 12px; color: var(--c-sage); font-weight: 600; }
.field input, .field textarea {
  background: var(--c-card); border: 1px solid var(--c-card-border); color: var(--c-cream);
  border-radius: 10px; padding: 11px 12px; font-size: 15px; font-family: var(--font-body);
  outline: none; width: 100%; resize: vertical;
}
.field input:focus, .field textarea:focus { border-color: var(--c-accent); }
.field input::placeholder, .field textarea::placeholder { color: #4A5E80; }

.primary-btn {
  background: var(--c-accent); color: #FFFFFF; border: none; border-radius: 12px;
  padding: 13px 18px; font-size: 15px; font-weight: 700; display: flex; align-items: center;
  justify-content: center; gap: 8px; cursor: pointer; font-family: var(--font-body);
}
.primary-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.secondary-btn {
  background: transparent; color: var(--c-cream); border: 1px solid var(--c-card-border); border-radius: 12px;
  padding: 13px 18px; font-size: 15px; font-weight: 600; display: flex; align-items: center;
  justify-content: center; gap: 8px; cursor: pointer; font-family: var(--font-body);
}
.inline-error { color: var(--c-red); font-size: 13px; display: flex; align-items: center; gap: 6px; }

/* ---------- CALENDAR ---------- */
.member-switcher { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 14px; }
.chip {
  background: var(--c-card); border: 1px solid var(--c-card-border); color: var(--c-sage);
  border-radius: 20px; padding: 6px 13px; font-size: 13px; font-weight: 600; cursor: pointer;
}
.chip.active { background: var(--c-accent); color: #FFFFFF; border-color: var(--c-accent); }

.streak-banner {
  background: var(--c-card); border: 1px solid var(--c-card-border); border-radius: 16px;
  padding: 16px; display: flex; align-items: center; gap: 12px; margin-bottom: 16px; flex-wrap: wrap;
}
.streak-num { display: flex; align-items: center; gap: 6px; font-family: var(--font-display); font-size: 26px; font-weight: 800; }
.streak-label { color: var(--c-sage); font-size: 12px; margin-right: auto; }
.month-stats { display: flex; gap: 10px; width: 100%; margin-top: 4px; }
.stat-chip { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--c-sage); }
.stat-dot { width: 7px; height: 7px; border-radius: 50%; display: inline-block; }

.month-nav { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.month-label { font-family: var(--font-display); font-size: 14px; font-weight: 700; letter-spacing: 0.02em; }

.cal-view-toggle { margin-bottom: 16px; }
.cal-view-section { display: flex; flex-direction: column; }

.cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 5px; margin-bottom: 16px; }
.cal-dow { text-align: center; font-size: 11px; color: var(--c-sage); font-weight: 700; padding-bottom: 4px; }
.cal-cell {
  aspect-ratio: 1; border-radius: 9px; border: none; background: var(--c-card);
  display: flex; align-items: center; justify-content: center; cursor: pointer;
  position: relative; font-size: 13px; font-weight: 700; font-family: var(--font-display);
  color: var(--c-sage);
}
.cal-cell.empty { background: transparent; cursor: default; }
.cal-cell.before-start { background: var(--c-future); color: #2C3F60; }
.cal-cell.today { box-shadow: 0 0 0 2px var(--c-cream) inset; }
.cal-cell.selected { box-shadow: 0 0 0 2px var(--c-amber) inset; }
.cal-pt-stamp {
  position: absolute; bottom: 2px; right: 3px; font-size: 8.5px; font-family: var(--font-mono);
  background: rgba(0,0,0,0.28); padding: 1px 3px; border-radius: 4px; font-weight: 700;
}

.group-cal-legend { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.group-cal-legend-item { display: flex; align-items: center; gap: 5px; font-size: 11.5px; color: var(--c-sage); }
.group-cal-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 16px; }
.group-cal-row {
  display: flex; align-items: center; gap: 12px; background: var(--c-card); border: 1px solid var(--c-card-border);
  border-radius: 10px; padding: 9px 12px; cursor: pointer; width: 100%; text-align: left;
}
.group-cal-row.today { border-color: var(--c-cream); }
.group-cal-row.selected { border-color: var(--c-amber); background: rgba(232,179,57,0.06); }
.group-cal-row-date { display: flex; align-items: baseline; gap: 5px; width: 46px; flex-shrink: 0; }
.group-cal-row-dow { font-size: 10.5px; color: var(--c-sage); font-weight: 700; text-transform: uppercase; }
.group-cal-row-num { font-family: var(--font-display); font-size: 14px; font-weight: 700; }
.group-cal-row-dots { display: flex; gap: 5px; flex-wrap: wrap; }
.group-dot { width: 13px; height: 13px; border-radius: 4px; display: inline-block; flex-shrink: 0; }
.group-dot.future { background: var(--c-future); }

.group-breakdown-list { display: flex; flex-direction: column; gap: 8px; }
.group-breakdown-row { display: flex; align-items: center; gap: 10px; }
.group-breakdown-name { flex: 1; font-size: 13.5px; font-weight: 600; }
.group-breakdown-hours { font-family: var(--font-mono); font-size: 11.5px; color: var(--c-sage); }
.status-pill.small { font-size: 10px; padding: 3px 8px; }
.member-avatar.tiny { width: 20px; height: 20px; font-size: 10px; }

.day-detail { background: var(--c-card); border: 1px solid var(--c-card-border); border-radius: 16px; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
.day-detail-head { display: flex; align-items: center; justify-content: space-between; }
.day-detail-date { font-family: var(--font-display); font-size: 15px; font-weight: 700; }
.status-pill { font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 20px; }
.day-detail-req { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--c-sage); }
.exemption-note { display: flex; align-items: center; gap: 6px; font-size: 12.5px; color: var(--c-amber); background: rgba(232,179,57,0.1); padding: 8px 10px; border-radius: 8px; }
.log-form { display: flex; flex-direction: column; gap: 10px; }
.logged-summary { font-size: 13px; color: var(--c-sage); background: rgba(255,255,255,0.03); padding: 8px 10px; border-radius: 8px; }
.muted-note { color: var(--c-sage); font-size: 13px; }
.muted-note.small { font-size: 12px; }

.day-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.action-btn {
  background: transparent; border: 1px solid var(--c-card-border); color: var(--c-cream);
  border-radius: 10px; padding: 8px 12px; font-size: 12.5px; font-weight: 600; cursor: pointer;
  display: flex; align-items: center; gap: 6px;
}
.action-btn:hover { border-color: var(--c-accent); }

.sub-form { display: flex; flex-direction: column; gap: 10px; background: rgba(255,255,255,0.03); border-radius: 12px; padding: 12px; }
.form-row-btns { display: flex; gap: 8px; }
.form-row-btns .primary-btn, .form-row-btns .secondary-btn { flex: 1; padding: 10px; }
.seg-control { display: flex; background: var(--c-bg); border-radius: 10px; padding: 3px; gap: 3px; }
.seg-control button { flex: 1; background: transparent; border: none; color: var(--c-sage); padding: 8px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; }
.seg-control button.active { background: var(--c-accent); color: #FFFFFF; }

.timelapse-list { display: flex; flex-direction: column; gap: 8px; }
.timelapse-card { display: flex; gap: 8px; align-items: flex-start; background: rgba(255,255,255,0.03); padding: 10px; border-radius: 10px; }
.timelapse-card-body { display: flex; flex-direction: column; gap: 3px; }
.timelapse-card-body a { color: var(--c-accent); font-size: 13px; font-weight: 600; text-decoration: none; }
.tl-status { font-size: 11.5px; color: var(--c-sage); }
.tl-status.counted { color: var(--c-green); }
.tl-status.rejected { color: var(--c-red); }

/* ---------- GROUP TAB ---------- */
.section-title { font-family: var(--font-display); font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; color: var(--c-sage); margin: 22px 0 10px; }
.section-title:first-child { margin-top: 0; }
.invite-card { display: flex; align-items: center; gap: 10px; background: var(--c-card); border: 1px solid var(--c-card-border); border-radius: 14px; padding: 14px; font-size: 13px; color: var(--c-sage); }
.member-list { display: flex; flex-direction: column; gap: 6px; }
.member-row { display: flex; align-items: center; gap: 10px; background: var(--c-card); border: 1px solid var(--c-card-border); border-radius: 12px; padding: 10px 12px; }
.member-avatar { width: 28px; height: 28px; border-radius: 50%; background: var(--c-pending); display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0; }
.member-name { flex: 1; font-size: 14px; font-weight: 600; }
.member-points { font-family: var(--font-mono); font-size: 12px; color: var(--c-sage); }
.rules-card { background: var(--c-card); border: 1px solid var(--c-card-border); border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px; }
.rules-card.editable { cursor: pointer; }
.rules-card.editable:hover { border-color: var(--c-accent); }
.tap-to-edit { font-size: 11px; color: var(--c-accent); font-weight: 600; margin-top: 2px; }
.settings-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.forfeit-card { display: flex; align-items: center; gap: 10px; background: var(--c-card); border: 1px solid var(--c-card-border); border-radius: 14px; padding: 14px; font-size: 13.5px; cursor: pointer; }

/* ---------- VOTES TAB ---------- */
.empty-state { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 50px 20px; text-align: center; }
.empty-text { font-weight: 700; font-size: 15px; }
.empty-sub { font-size: 12.5px; color: var(--c-sage); max-width: 240px; }
.vote-card { background: var(--c-card); border: 1px solid var(--c-card-border); border-radius: 14px; padding: 13px; margin-bottom: 10px; display: flex; flex-direction: column; gap: 8px; }
.vote-card-head { display: flex; align-items: center; gap: 8px; }
.vote-card-who { font-weight: 700; font-size: 13.5px; }
.vote-card-date { color: var(--c-sage); font-size: 12px; margin-right: auto; }
.vote-badge { font-size: 10.5px; font-weight: 700; padding: 3px 8px; border-radius: 20px; }
.vote-badge.open { background: rgba(232,179,57,0.15); color: var(--c-amber); }
.vote-badge.granted { background: rgba(54,214,168,0.15); color: var(--c-green); }
.vote-badge.denied { background: rgba(226,72,61,0.15); color: var(--c-red); }
.vote-card-detail { font-size: 13px; }
.vote-card-reason { font-size: 13px; color: var(--c-sage); font-style: italic; }
.vote-card-link { display: flex; align-items: center; gap: 6px; color: var(--c-accent); font-size: 13px; font-weight: 600; text-decoration: none; }
.vote-buttons { display: flex; gap: 8px; }
.vote-btn { flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px; padding: 9px; border-radius: 10px; border: 1px solid var(--c-card-border); background: transparent; color: var(--c-cream); font-size: 12.5px; font-weight: 600; cursor: pointer; }
.vote-btn.yes.selected { background: var(--c-green); color: var(--c-ink); border-color: var(--c-green); }
.vote-btn.no.selected { background: var(--c-red); color: var(--c-cream); border-color: var(--c-red); }
.vote-tally { display: flex; flex-direction: column; gap: 5px; }
.vote-tally-bar { height: 5px; background: var(--c-bg); border-radius: 4px; overflow: hidden; }
.vote-tally-fill { height: 100%; background: var(--c-accent); }
.vote-tally span { font-size: 11px; color: var(--c-sage); }

/* ---------- STANDINGS ---------- */
.standings-list { display: flex; flex-direction: column; gap: 6px; }
.standing-row { display: flex; align-items: center; gap: 10px; background: var(--c-card); border: 1px solid var(--c-card-border); border-radius: 12px; padding: 10px 12px; }
.standing-row.me { border-color: var(--c-accent); }
.standing-rank { font-family: var(--font-mono); font-size: 12px; color: var(--c-sage); width: 14px; }
.standing-mid { flex: 1; display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.standing-name { font-size: 13.5px; font-weight: 600; }
.standing-bar-track { height: 4px; background: var(--c-bg); border-radius: 4px; overflow: hidden; }
.standing-bar-fill { height: 100%; background: var(--c-red); }
.standing-pts { font-family: var(--font-display); font-size: 16px; font-weight: 800; }
.standing-streak { display: flex; align-items: center; gap: 2px; font-size: 11px; color: var(--c-sage); }
.loser-card { display: flex; gap: 12px; background: rgba(226,72,61,0.1); border: 1px solid rgba(226,72,61,0.3); border-radius: 14px; padding: 14px; margin-top: 16px; }
.loser-card-title { display: block; font-weight: 700; font-size: 13.5px; margin-bottom: 3px; }
.loser-card-forfeit { display: block; font-size: 12.5px; color: var(--c-sage); }
.all-clean-card { display: flex; gap: 10px; align-items: center; background: rgba(54,214,168,0.1); border: 1px solid rgba(54,214,168,0.3); border-radius: 14px; padding: 14px; margin-top: 16px; font-size: 13px; }

/* ---------- TOAST ---------- */
.toast {
  position: absolute; bottom: 78px; left: 50%; transform: translateX(-50%);
  background: var(--c-cream); color: var(--c-ink); padding: 10px 16px; border-radius: 24px;
  font-size: 13px; font-weight: 600; display: flex; align-items: center; gap: 7px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.3); z-index: 50; animation: toast-in 0.25s ease-out; max-width: 85%;
}
.toast.error { background: var(--c-red); color: var(--c-cream); }
.toast.success { background: var(--c-green); color: var(--c-ink); }
@keyframes toast-in { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }

@media (prefers-reduced-motion: reduce) {
  .spin { animation: none; }
  .toast { animation: none; }
}
`;
