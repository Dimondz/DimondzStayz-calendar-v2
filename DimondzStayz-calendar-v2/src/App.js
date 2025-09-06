import React, { useEffect, useMemo, useRef, useState } from "react";
import FullCalendar from "@fullcalendar/react";
import dayGridPlugin from "@fullcalendar/daygrid";
import timeGridPlugin from "@fullcalendar/timegrid";
import interactionPlugin from "@fullcalendar/interaction";
import { Calendar as CalendarIcon, Plus, RefreshCw, Trash2, Upload, Download, AlertTriangle, Link as LinkIcon, Save, Clock } from "lucide-react";
import * as ICAL from "ical.js";

// ---- Small utilities ----
const uid = () => Math.random().toString(36).slice(2);
const DEFAULT_COLOR_MAP = {
  airbnb: "bg-rose-500",
  booking: "bg-blue-500",
  other: "bg-emerald-500",
};

const SOURCE_LABELS = {
  airbnb: "Airbnb",
  booking: "Booking.com",
  other: "Other",
};

function classNames(...v) {
  return v.filter(Boolean).join(" ");
}

function toISOStringLocal(d) {
  // Ensure dates render correctly in FullCalendar
  return new Date(d).toISOString();
}

function icsFromEvents(events) {
  const cal = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Dimondz Stayz//Merged BnB Calendar//EN",
    "CALSCALE:GREGORIAN",
  ];
  events.forEach((ev) => {
    const dtStart = new Date(ev.start);
    const dtEnd = new Date(ev.end || ev.start);
    const fmt = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    cal.push(
      "BEGIN:VEVENT",
      `UID:${ev.id || uid()}@mergedbnb`,
      `DTSTAMP:${fmt(new Date())}`,
      `DTSTART:${fmt(dtStart)}`,
      `DTEND:${fmt(dtEnd)}`,
      `SUMMARY:${(ev.title || "Booking").replace(/\n/g, " ")}`,
      `DESCRIPTION:${(ev.extendedProps?.sourceName || "Merged").replace(/\n/g, " ")}`,
      "END:VEVENT"
    );
  });
  cal.push("END:VCALENDAR");
  return cal.join("\r\n");
}

// Deduplicate events: prefer by UID, else by same title + overlapping time
function dedupeEvents(evts) {
  const byUid = new Map();
  const out = [];
  evts.forEach((e) => {
    const key = e.uid || e.id || `${e.title}-${e.start}-${e.end}`;
    if (!byUid.has(key)) {
      byUid.set(key, true);
      out.push(e);
    }
  });
  return out;
}

function detectConflicts(events) {
  const conflicts = [];
  const sorted = [...events].sort((a, b) => new Date(a.start) - new Date(b.start));
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (new Date(b.start) >= new Date(a.end)) break; // no overlap further
      // overlap
      conflicts.push([a, b]);
    }
  }
  return conflicts;
}

// Try fetch with optional CORS fallback
async function fetchTextWithFallback(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (e) {
    // Optional public CORS mirror. If blocked, user can paste a proxy in settings.
    const corsHelpers = [
      "https://cors.isomorphic-git.org/", // simple passthrough
    ];
    for (const prefix of corsHelpers) {
      try {
        const res = await fetch(prefix + url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      } catch (_) {}
    }
    throw e;
  }
}

function parseICS(icsText, sourceId, sourceName, colorClass) {
  const jcalData = ICAL.parse(icsText);
  const comp = new ICAL.Component(jcalData);
  const vevents = comp.getAllSubcomponents("vevent");
  const events = vevents.map((ve) => {
    const ev = new ICAL.Event(ve);
    return {
      id: ev.uid || uid(),
      uid: ev.uid,
      title: ev.summary || "Booking",
      start: toISOStringLocal(ev.startDate.toJSDate()),
      end: toISOStringLocal((ev.endDate || ev.startDate).toJSDate()),
      allDay: ev.startDate.isDate,
      backgroundColor: undefined, // let class control it
      className: [colorClass, "text-white", "border", "border-white/10", "rounded"],
      extendedProps: {
        sourceId,
        sourceName,
      },
    };
  });
  return events;
}

const DEFAULT_STATE = {
  sources: [
    // { id, name, type: 'airbnb'|'booking'|'other', url }
  ],
  refreshMinutes: 30,
};

export default function App() {
  const [state, setState] = useState(() => {
    const saved = localStorage.getItem("merged-bnb-state");
    return saved ? JSON.parse(saved) : DEFAULT_STATE;
  });
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [newSrc, setNewSrc] = useState({ name: "", type: "airbnb", url: "" });
  const refreshTimerRef = useRef(null);

  useEffect(() => {
    localStorage.setItem("merged-bnb-state", JSON.stringify(state));
  }, [state]);

  const colorFor = (type) => DEFAULT_COLOR_MAP[type] || DEFAULT_COLOR_MAP.other;

  const loadAll = async () => {
    setLoading(true);
    setError("");
    try {
      const lists = await Promise.all(
        state.sources.map(async (s) => {
          const text = await fetchTextWithFallback(s.url);
          return parseICS(text, s.id, s.name, colorFor(s.type));
        })
      );
      const merged = dedupeEvents(lists.flat());
      setEvents(merged);
    } catch (e) {
      console.error(e);
      setError(
        "Some calendars couldn't be loaded. If this is a CORS issue, try downloading the .ics and uploading it below, or host via a CORS-friendly proxy."
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadAll();
    if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    if (state.refreshMinutes && state.refreshMinutes > 0) {
      refreshTimerRef.current = setInterval(loadAll, state.refreshMinutes * 60 * 1000);
    }
    return () => refreshTimerRef.current && clearInterval(refreshTimerRef.current);
  }, [state.sources, state.refreshMinutes]);

  const conflicts = useMemo(() => detectConflicts(events), [events]);

  const onAddSource = () => {
    if (!newSrc.url || !newSrc.name) return;
    const src = { id: uid(), ...newSrc };
    setState((s) => ({ ...s, sources: [...s.sources, src] }));
    setNewSrc({ name: "", type: "airbnb", url: "" });
  };

  const onRemoveSource = (id) => {
    setState((s) => ({ ...s, sources: s.sources.filter((x) => x.id !== id) }));
  };

  const onUploadICS = async (file, assumedType = "other") => {
    const text = await file.text();
    const srcId = uid();
    const srcName = `${file.name.replace(/\.ics$/i, "")} (upload)`;
    const evs = parseICS(text, srcId, srcName, colorFor(assumedType));
    setEvents((prev) => dedupeEvents([...prev, ...evs]));
  };

  const downloadMergedICS = () => {
    const ics = icsFromEvents(events);
    const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "merged-bnb-calendar.ics";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900 p-4 md:p-8">
      {/* Header */}
      <header className="max-w-6xl mx-auto mb-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-2xl bg-slate-900 text-white shadow">
            <CalendarIcon size={24} />
          </div>
          <div>
            <h1 className="text-2xl md:text-3xl font-bold">Merged BnB Calendars</h1>
            <p className="text-sm text-slate-600">Combine Airbnb and Booking.com iCal feeds into one live calendar. Local-only; your URLs never leave your browser.</p>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left: Sources & Tools */}
        <section className="lg:col-span-1 space-y-6">
          {/* Add source */}
          <div className="bg-white rounded-2xl shadow p-4 space-y-4">
            <h2 className="font-semibold text-lg flex items-center gap-2"><LinkIcon size={18}/> Add Calendar Source</h2>
            <div className="grid grid-cols-1 gap-3">
              <label className="text-sm">Name</label>
              <input className="w-full rounded-xl border p-2" placeholder="e.g. Beach House – Airbnb" value={newSrc.name} onChange={(e)=>setNewSrc({...newSrc, name:e.target.value})} />
              <label className="text-sm">Type</label>
              <select className="w-full rounded-xl border p-2" value={newSrc.type} onChange={(e)=>setNewSrc({...newSrc, type:e.target.value})}>
                <option value="airbnb">Airbnb</option>
                <option value="booking">Booking.com</option>
                <option value="other">Other</option>
              </select>
              <label className="text-sm">iCal URL (.ics)</label>
              <input className="w-full rounded-xl border p-2" placeholder="https://... .ics" value={newSrc.url} onChange={(e)=>setNewSrc({...newSrc, url:e.target.value})} />
              <button onClick={onAddSource} className="inline-flex items-center gap-2 bg-slate-900 text-white rounded-xl px-3 py-2 hover:opacity-90"><Plus size={16}/> Add Source</button>
              <p className="text-xs text-slate-500">Tip: In Airbnb, go to <em>Listing → Availability → Export Calendar</em>. In Booking.com, go to <em>Calendar → Sync calendars → Export</em>.</p>
            </div>
          </div>

          {/* Sources list */}
          <div className="bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold text-lg mb-3">Connected Sources</h2>
            <ul className="space-y-2">
              {state.sources.length === 0 && (
                <li className="text-sm text-slate-500">No sources yet. Add an iCal URL above.</li>
              )}
              {state.sources.map((s)=> (
                <li key={s.id} className="flex items-center justify-between gap-2 border rounded-xl p-2">
                  <div>
                    <div className="font-medium">{s.name}</div>
                    <div className="text-xs text-slate-500">{SOURCE_LABELS[s.type]} • {s.url}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={classNames("inline-block w-3 h-3 rounded-full", DEFAULT_COLOR_MAP[s.type])}></span>
                    <button title="Remove" onClick={()=>onRemoveSource(s.id)} className="p-2 rounded-lg hover:bg-slate-100"><Trash2 size={16}/></button>
                  </div>
                </li>
              ))}
            </ul>
            <div className="mt-4 flex items-center gap-2">
              <button onClick={loadAll} className="inline-flex items-center gap-2 bg-white border rounded-xl px-3 py-2 hover:bg-slate-50">
                <RefreshCw size={16}/> Refresh
              </button>
              <div className="flex items-center gap-2 text-sm">
                <Clock size={16}/>
                <span>Auto-refresh</span>
                <input type="number" min={0} className="w-16 rounded-lg border p-1" value={state.refreshMinutes} onChange={(e)=>setState({...state, refreshMinutes: parseInt(e.target.value||"0",10) })}/>
                <span>min</span>
              </div>
            </div>
            {loading && <p className="mt-3 text-sm">Loading calendars…</p>}
            {error && (
              <div className="mt-3 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-xl p-2 flex items-start gap-2">
                <AlertTriangle size={16}/> <span>{error}</span>
              </div>
            )}
          </div>

          {/* Upload .ics fallback */}
          <div className="bg-white rounded-2xl shadow p-4 space-y-3">
            <h2 className="font-semibold text-lg flex items-center gap-2"><Upload size={18}/> Upload .ics (optional)</h2>
            <p className="text-sm text-slate-600">If a site blocks cross‑origin requests, download the .ics file and upload it here to include those bookings in the merge.</p>
            <div className="flex items-center gap-2">
              <input id="file" type="file" accept="text/calendar,.ics" className="hidden" onChange={(e)=> e.target.files && onUploadICS(e.target.files[0]) }/>
              <label htmlFor="file" className="cursor-pointer inline-flex items-center gap-2 bg-white border rounded-xl px-3 py-2 hover:bg-slate-50"><Upload size={16}/> Choose file</label>
            </div>
          </div>

          {/* Export */}
          <div className="bg-white rounded-2xl shadow p-4 space-y-3">
            <h2 className="font-semibold text-lg flex items-center gap-2"><Download size={18}/> Export</h2>
            <p className="text-sm text-slate-600">Download a merged .ics you can import to Google Calendar, Apple Calendar, Outlook, etc.</p>
            <button onClick={downloadMergedICS} className="inline-flex items-center gap-2 bg-slate-900 text-white rounded-xl px-3 py-2 hover:opacity-90"><Download size={16}/> Download merged .ics</button>
          </div>
        </section>

        {/* Right: Calendar */}
        <section className="lg:col-span-2">
          <div className="bg-white rounded-2xl shadow p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="font-semibold text-lg flex items-center gap-2"><CalendarIcon size={18}/> Calendar</h2>
              <div className="text-sm text-slate-600">{events.length} events</div>
            </div>
            <FullCalendar
              plugins={[dayGridPlugin, timeGridPlugin, interactionPlugin]}
              initialView="dayGridMonth"
              headerToolbar={{ left: "prev,next today", center: "title", right: "dayGridMonth,timeGridWeek,timeGridDay" }}
              height={700}
              events={events}
              displayEventTime={false}
            />
          </div>

          {/* Conflicts */}
          <div className="mt-6 bg-white rounded-2xl shadow p-4">
            <h2 className="font-semibold text-lg mb-2 flex items-center gap-2"><AlertTriangle size={18}/> Potential Double‑Bookings</h2>
            {conflicts.length === 0 ? (
              <p className="text-sm text-slate-600">No overlaps detected 🎉</p>
            ) : (
              <ul className="space-y-2">
                {conflicts.map(([a,b], idx)=> (
                  <li key={idx} className="border rounded-xl p-2">
                    <div className="text-sm font-medium">{a.title} ↔ {b.title}</div>
                    <div className="text-xs text-slate-600">{new Date(a.start).toLocaleString()} → {new Date(a.end).toLocaleString()}</div>
                    <div className="text-xs text-slate-600">
                      {a.extendedProps.sourceName} • {b.extendedProps.sourceName}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </main>

      <footer className="max-w-6xl mx-auto mt-8 text-xs text-slate-500">
        <p>
          This is a lightweight, local-only tool inspired by Guesty-style calendar merging. For true PMS features (messaging, pricing, multi‑channel inventory), you’d connect a server and channel managers—but this gets you a reliable, merged view fast.
        </p>
      </footer>
    </div>
  );
}