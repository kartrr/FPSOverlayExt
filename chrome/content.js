(() => {
  // ---------- Config ----------
  const HOTKEY = { ctrl: true, alt: true, key: "f" }; // Ctrl+Alt+F toggle
  const SAMPLE_SEC = 1.0;
  const LOW_WINDOW = 5.0;
  const UPDATE_HZ = 10;
  // const START_VISIBLE = true; // <-- УДАЛИЛИ, теперь берем из настроек

  // UI
  const THEME_BG = "rgba(0,0,0,0.7)";
  const THEME_FG = "#e6f3ff";
  const DANGER = "#ff6b6b";
  const Z = 2147483647;

  // FPS chart
  const CHART_W = 200;
  const CHART_H = 42;
  const CHART_HISTORY = 120; // ~12s @ 10Hz

  // Cross-frame DOM aggregation
  const FRAME_PING_MS = 1000; 
  const CHANNEL = "__FPS_OVERLAY_DOM_COUNT__";
  const frameId = Math.random().toString(36).slice(2);
  const isTop = window === window.top;

  // ---------- Storage helpers ----------
  const api = (typeof browser !== "undefined" ? browser : (typeof chrome !== "undefined" ? chrome : null));
  async function storageGet(defaults) {
    try { if (api?.storage?.sync?.get) return Object.assign({}, defaults, await api.storage.sync.get(defaults)); } catch {}
    const out = { ...defaults };
    try { for (const k of Object.keys(defaults)) { const r = localStorage.getItem("__fps_pref__:"+k); if (r!=null) out[k]=JSON.parse(r);} } catch {}
    return out;
  }
  function storageSet(obj) {
    try { if (api?.storage?.sync?.set) return api.storage.sync.set(obj); } catch {}
    try { for (const [k,v] of Object.entries(obj)) localStorage.setItem("__fps_pref__:"+k, JSON.stringify(v)); } catch {}
  }

  // ---------- Preferences ----------
  const DEFAULT_PREFS = {
    isOverlayVisible: true, // <-- ДОБАВИЛИ: Сохраняем состояние видимости
    showChart: true,
    showFPS: true,
    showLow1: true,
    showFrameTime: true,
    showLag: true,
    showMemory: true,
    showDOM: true,
    showLongTasks: true,
    enableThresholds: true,
    thrFpsMin: 55,
    thrHeapMaxMB: 512, // threshold vs used
    thrDomMax: 3000,
    thrLagMaxMs: 50
  };
  let PREFS = { ...DEFAULT_PREFS };

  // ---------- State ----------
  let visible = true; // Начальное значение будет перезаписано при старте
  let rafId = 0;
  const frames = [];
  const framesLong = [];
  let eventLoopLagMs = 0;
  let longTaskBudgetMs = 0;

  // FPS chart
  const fpsHistory = [];
  let chartCanvas, chartCtx;

  // DOM aggregation
  const frameCounts = new Map(); // frameId -> count
  let _domTotalCache = 0;
  let _domCacheTs = 0;

  // HUD refs
  let hud, label, gear, panel, chartWrap;

  // ---------- Metrics shared (used both in top & child frames) ----------
  function countElementsDeep(rootEl) {
    if (!rootEl) return 0;
    let cnt = 0;
    const stack = [rootEl];
    while (stack.length) {
      const n = stack.pop();
      const type = n.nodeType;
      if (type === Node.DOCUMENT_NODE || type === Node.DOCUMENT_FRAGMENT_NODE) {
        for (const ch of n.children || []) stack.push(ch);
      } else if (type === Node.ELEMENT_NODE) {
        cnt++;
        if (n.shadowRoot) stack.push(n.shadowRoot);
        for (const ch of n.children) stack.push(ch);
      }
    }
    return cnt;
  }
  function getOwnDomCount() {
    try { return countElementsDeep(document.documentElement); } catch { return 0; }
  }

  // ---------- CHILD FRAMES: periodically send own count to top ----------
  function childFrameLoop() {
    const send = () => {
      const count = getOwnDomCount();
      try { window.top.postMessage({ __ch: CHANNEL, id: frameId, count }, "*"); } catch {}
    };
    send();
    setInterval(send, FRAME_PING_MS);
  }

  if (!isTop) {
    childFrameLoop();
    return; 
  }

  // ---------- TOP FRAME ONLY BELOW ----------
  function installTopMessageHandler() {
    window.addEventListener("message", (e) => {
      const d = e.data;
      if (!d || d.__ch !== CHANNEL) return;
      frameCounts.set(d.id, Number(d.count) || 0);
    });
  }
  installTopMessageHandler();

  frameCounts.set("top:"+frameId, getOwnDomCount());
  setInterval(() => frameCounts.set("top:"+frameId, getOwnDomCount()), FRAME_PING_MS);

  // ---------- Memory helpers ----------
  function getMemoryStatsMB() {
    const m = performance.memory || null;
    if (!m) return null;
    return {
      used:  m.usedJSHeapSize   / (1024*1024),
      total: m.totalJSHeapSize  / (1024*1024),
      limit: m.jsHeapSizeLimit  / (1024*1024)
    };
  }

  // ---------- HUD ----------
  function ensureHUD() {
    if (hud) return hud;
    hud = document.createElement("div");
    hud.id = "__fps_overlay__";
    Object.assign(hud.style, {
      position: "fixed", top: "12px", left: "12px", zIndex: Z,
      background: THEME_BG, color: THEME_FG,
      font: "12px/1.4 system-ui,-apple-system,Segoe UI,Roboto,Arial",
      padding: "10px 12px", borderRadius: "10px",
      boxShadow: "0 8px 24px rgba(0,0,0,.35)", userSelect: "none",
      whiteSpace: "pre", minWidth: "210px", backdropFilter: "blur(4px)"
    });

    const header = document.createElement("div");
    header.style.display = "flex"; header.style.alignItems = "center";
    header.style.justifyContent = "space-between"; header.style.marginBottom = "6px";

    const title = document.createElement("div");
    title.textContent = "Performance Overlay"; title.style.fontWeight = "600"; title.style.cursor = "move";

    // drag
    let dragging=false, dx=0, dy=0;
    title.addEventListener("mousedown", e=>{ dragging=true; dx=e.clientX-hud.offsetLeft; dy=e.clientY-hud.offsetTop; e.preventDefault(); });
    window.addEventListener("mousemove", e=>{ if(!dragging) return; hud.style.left=Math.max(4,e.clientX-dx)+"px"; hud.style.top=Math.max(4,e.clientY-dy)+"px"; });
    window.addEventListener("mouseup", ()=> dragging=false);

    // gear
    gear = document.createElement("button");
    gear.type = "button"; gear.setAttribute("aria-label","Settings"); gear.textContent = "⚙️";
    Object.assign(gear.style, {
      background:"rgba(255,255,255,0.06)", border:"1px solid rgba(255,255,255,0.15)", color:THEME_FG,
      cursor:"pointer", fontSize:"13px", lineHeight:"1", width:"22px", height:"22px",
      display:"inline-flex", alignItems:"center", justifyContent:"center",
      padding:"0", margin:"0 0 0 8px", borderRadius:"11px", outline:"none", boxShadow:"none"
    });
    gear.addEventListener("focus", ()=>{ gear.style.boxShadow="0 0 0 2px rgba(0,255,255,0.7)"; });
    gear.addEventListener("blur",  ()=>{ gear.style.boxShadow="none"; });
    gear.addEventListener("click", togglePanel);

    header.appendChild(title); header.appendChild(gear);

    // chart
    chartWrap = document.createElement("div");
    chartWrap.style.margin = "4px 0 6px 0";
    chartCanvas = document.createElement("canvas");
    chartCanvas.width = CHART_W; chartCanvas.height = CHART_H;
    chartCanvas.style.display = PREFS.showChart ? "block" : "none";
    chartCtx = chartCanvas.getContext("2d");
    chartWrap.appendChild(chartCanvas);

    label = document.createElement("div");
    panel = buildSettingsPanel();

    hud.appendChild(header);
    hud.appendChild(chartWrap);
    hud.appendChild(label);
    hud.appendChild(panel);
    document.documentElement.appendChild(hud);
    return hud;
  }
  function setVisible(v){ visible=v; if(!hud) ensureHUD(); hud.style.display = v?"block":"none"; }
  function togglePanel(){ if(!panel) return; panel.style.display = (panel.style.display==="none"||!panel.style.display)?"block":"none"; }

  // ---------- Settings panel ----------
  function buildSettingsPanel(){
    const p=document.createElement("div");
    Object.assign(p.style,{display:"none",marginTop:"8px",padding:"8px",background:"rgba(255,255,255,0.06)",borderRadius:"8px",border:"1px solid rgba(255,255,255,0.15)"});
    p.appendChild(sectionTitle("Metrics"));
    [["showChart","Show FPS Chart"],["showFPS","Show FPS"],["showLow1","Show 1% Low"],["showFrameTime","Show Frame Time"],["showLag","Show Event Loop Lag"],["showMemory","Show JS Heap"],["showDOM","Show DOM Nodes (all frames)"],["showLongTasks","Show Long Tasks total"]]
      .forEach(([k,t])=>p.appendChild(rowCheckbox(k,t)));
    p.appendChild(sectionTitle("Thresholds"));
    p.appendChild(rowCheckbox("enableThresholds","Enable thresholds"));
    p.appendChild(rowNumber("thrFpsMin","FPS < ",1,1000,1));
    p.appendChild(rowNumber("thrLagMaxMs","Event Loop Lag > (ms) ",1,10000,1));
    p.appendChild(rowNumber("thrHeapMaxMB","JS Heap > (MB) ",1,16384,1));
    p.appendChild(rowNumber("thrDomMax","DOM Nodes > ",1,10000000,100));
    return p;
  }
  function sectionTitle(t){const d=document.createElement("div");d.textContent=t;d.style.fontWeight="600";d.style.margin="6px 0 4px 0";return d;}
  function rowCheckbox(key,text){
    const row=document.createElement("label");row.style.display="flex";row.style.alignItems="center";row.style.gap="8px";
    const cb=document.createElement("input");cb.type="checkbox";cb.checked=!!PREFS[key];
    cb.addEventListener("change",()=>{PREFS[key]=cb.checked;storageSet({[key]:PREFS[key]}); if(key==="showChart"&&chartCanvas){chartCanvas.style.display=PREFS.showChart?"block":"none";}});
    const span=document.createElement("span");span.textContent=text; row.appendChild(cb); row.appendChild(span); return row;
  }
  function rowNumber(key,text,min,max,step){
    const wrap=document.createElement("div");wrap.style.display="flex";wrap.style.alignItems="center";wrap.style.gap="6px";
    const l=document.createElement("span");l.textContent=text;
    const input=document.createElement("input");input.type="number";input.min=min;input.max=max;input.step=step;input.value=PREFS[key];
    input.addEventListener("change",()=>{PREFS[key]=Number(input.value);storageSet({[key]:PREFS[key]});});
    wrap.appendChild(l);wrap.appendChild(input);return wrap;
  }

  // ---------- Perf metrics (top only) ----------
  function tick(ts){
    frames.push(ts); framesLong.push(ts);
    const cutoff=ts-SAMPLE_SEC*1000; while(frames.length&&frames[0]<cutoff) frames.shift();
    const cutoffL=ts-LOW_WINDOW*1000; while(framesLong.length&&framesLong[0]<cutoffL) framesLong.shift();
    rafId=requestAnimationFrame(tick);
  }
  (function measureLag(){ let last=performance.now(); setInterval(()=>{ const now=performance.now(); eventLoopLagMs=Math.max(0, now-(last+100)); last=now; },100); })();
  if ("PerformanceObserver" in window) { try { const po=new PerformanceObserver(list=>{ for (const e of list.getEntries()) if (e.entryType==="longtask") longTaskBudgetMs+=e.duration; }); po.observe({entryTypes:["longtask"]}); } catch{} }

  function getFPS(){ return frames.length / SAMPLE_SEC; }
  function getLow1Percent(){
    if (framesLong.length < 3) return NaN;
    const arr=[]; for (let i=1;i<framesLong.length;i++) arr.push(framesLong[i]-framesLong[i-1]);
    arr.sort((a,b)=>a-b); const idx=Math.floor(arr.length*0.99); const p99=arr[Math.min(arr.length-1,Math.max(0,idx))];
    return 1000 / p99;
  }

  // ---------- DOM total (all frames) ----------
  function getDomTotalCached(){
    const now=performance.now();
    if (now - _domCacheTs > 1000) {
      let sum = 0;
      for (const v of frameCounts.values()) sum += v|0;
      _domTotalCache = sum;
      _domCacheTs = now;
    }
    return _domTotalCache;
  }

  // ---------- FPS chart ----------
  function pushFpsSample(v){ fpsHistory.push(v); if (fpsHistory.length>CHART_HISTORY) fpsHistory.shift(); }
  function drawChart(){
    if (!chartCtx || !PREFS.showChart) return;
    const ctx=chartCtx; ctx.clearRect(0,0,CHART_W,CHART_H);
    ctx.strokeStyle="rgba(255,255,255,0.25)"; ctx.setLineDash([3,3]);
    [60,30].forEach(f=>{ const y=mapFpsToY(f); ctx.beginPath(); ctx.moveTo(0,y); ctx.lineTo(CHART_W,y); ctx.stroke(); });
    ctx.setLineDash([]);
    ctx.strokeStyle="#3bff75"; ctx.lineWidth=2; ctx.beginPath();
    fpsHistory.forEach((v,i)=>{ const x=(i/(CHART_HISTORY-1))*(CHART_W-1); const y=mapFpsToY(v); if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y); });
    ctx.stroke();
  }
  function mapFpsToY(f){ const min=0,max=120; const c=Math.max(min,Math.min(max,f)); const t=(c-min)/(max-min); return CHART_H-1-t*(CHART_H-1); }

  // ---------- Formatting ----------
  const fmtInt = x => Number.isFinite(x) ? String(Math.round(x)) : "n/a";
  const fmt1   = x => Number.isFinite(x) ? x.toFixed(1) : "n/a";
  const line = (name,val,bad)=> bad?`<span style="color:${DANGER}">${name}: ${val}</span>`:`${name}: ${val}`;

  // ---------- Render ----------
  function buildHTML(fps){
    const out=[];
    if (PREFS.showFPS) out.push(line("FPS", fmtInt(fps), PREFS.enableThresholds && fps < PREFS.thrFpsMin));
    if (PREFS.showLow1) out.push("1% low: " + fmtInt(getLow1Percent()));
    if (PREFS.showFrameTime){ const n=frames.length; const ft=(n>=2)?(frames[n-1]-frames[n-2]):NaN; out.push("Frame time: "+fmt1(ft)+" ms"); }
    if (PREFS.showLag) out.push(line("Event loop lag", fmt1(eventLoopLagMs)+" ms", PREFS.enableThresholds && eventLoopLagMs > PREFS.thrLagMaxMs));
    if (PREFS.showMemory){ const m=getMemoryStatsMB(); out.push(m ? line("JS Heap", `${fmtInt(m.used)} MB used / ${fmtInt(m.total)} MB total`, PREFS.enableThresholds && m.used > PREFS.thrHeapMaxMB) : "JS Heap: n/a"); }
    if (PREFS.showDOM){ const dom=getDomTotalCached(); out.push(line("DOM Nodes (all frames)", fmtInt(dom), PREFS.enableThresholds && dom > PREFS.thrDomMax)); }
    if (PREFS.showLongTasks && longTaskBudgetMs) out.push("Long Tasks: "+fmtInt(longTaskBudgetMs)+" ms total");
    out.push("Toggle: Ctrl+Alt+F");
    return out.join("\n");
  }
  function renderOnce(){ if (!label) ensureHUD(); const fps=getFPS(); pushFpsSample(fps); drawChart(); label.innerHTML=buildHTML(fps); }
  function renderLoop(){ renderOnce(); setTimeout(renderLoop, 1000/UPDATE_HZ); }

  // ---------- Hotkey ----------
  window.addEventListener("keydown", e => {
    if (!!e.ctrlKey===HOTKEY.ctrl && !!e.altKey===HOTKEY.alt && e.key.toLowerCase()===HOTKEY.key) {
      const newState = !visible;
      setVisible(newState);
      PREFS.isOverlayVisible = newState; // <-- ИЗМЕНЕНИЕ: обновляем локальный объект
      storageSet({ isOverlayVisible: newState }); // <-- ИЗМЕНЕНИЕ: сохраняем в сторадж
      e.preventDefault();
    }
  }, true);

  // ---------- Start ----------
  (async function start(){
    PREFS=await storageGet(DEFAULT_PREFS);
    setInterval(()=>{ frameCounts.set("top:"+CHANNEL, getOwnDomCount()); }, FRAME_PING_MS);

    ensureHUD();
    hud.removeChild(panel); panel=buildSettingsPanel(); hud.appendChild(panel);
    
    // <-- ИЗМЕНЕНИЕ: берем видимость из PREFS, а не константы
    setVisible(PREFS.isOverlayVisible); 
    
    requestAnimationFrame(tick);
    renderLoop();
  })();
})();