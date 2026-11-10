// Behaviour script of 'Assistant Prototype.dc.html' (claude.ai/design project dc036147-9edb-46ef-b923-46ff68513b70), copied verbatim 2026-11-10 as the interaction reference. Not app code.
class Component extends DCLogic {
  state = {
    open: this.props.startOpen ?? true,
    mode: this.props.startMode ?? 'popover',
    page: 'today',
    threads: [{ id: 't1', title: 'New thread', age: 'now' }],
    store: { t1: [] },
    tid: 't1',
    draft: '',
    spokenDraft: false,
    busy: '',
    mic: 'idle',
    micSecs: 0,
    ctxOn: true,
    menu: null,
    trust: 'judge',
    created: false,
    judge: this.props.judgeConfigured ?? false,
    changes: [],
    phrase: 0,
  };
  seq = 0;
  timers = [];
  inputRef = React.createRef();
  bodyRef = React.createRef();

  PAGES = {
    today: { label: 'Today', route: '/', title: 'Today', desc: 'What needs you across projects.' },
    catchup: { label: 'Catch up', route: '/catch-up', title: 'Catch up', desc: 'What the agents did while you were away.' },
    threads: { label: 'Threads', route: '/threads', title: 'Threads', desc: 'One-off threads with agents.' },
    workflows: { label: 'Workflows', route: '/workflows', title: 'Workflows', desc: '3 workflows · 2 samples from the install' },
    agents: { label: 'Agents', route: '/profiles', title: 'Agents', desc: '2 agent profiles' },
    homelab: { label: 'home-lab', route: '/p/home-lab', title: 'home-lab', desc: 'Project · 1 repository · no workflow yet' },
  };
  PHRASES = ['what workflows do I have', 'do you have access to any github tokens', 'how do I add a new repo'];

  componentDidMount() {
    this.onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') { e.preventDefault(); this.setState((s) => ({ open: !s.open, menu: null }), () => this.state.open && this.ensureSetup()); }
      else if (e.key === 'Escape') {
        if (this.state.menu) this.setState({ menu: null });
        else if (this.state.open) this.setState({ open: false });
      }
    };
    window.addEventListener('keydown', this.onKey);
    if (this.state.open) this.ensureSetup();
    this.onResize = () => this.setState({ vw: window.innerWidth });
    window.addEventListener('resize', this.onResize);
    this.onResize();
  }
  componentWillUnmount() {
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('resize', this.onResize);
    this.timers.forEach(clearTimeout);
    clearInterval(this.micTimer);
  }
  componentDidUpdate(_, prev) {
    const cur = this.state.store[this.state.tid] || [];
    const old = prev.store[prev.tid] || [];
    if (cur.length !== old.length || this.state.busy !== prev.busy || this.state.mode !== prev.mode) {
      requestAnimationFrame(() => {
        const el = document.querySelector('[data-pt-body]');
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  }

  ensureSetup() {
    const s = this.state;
    if ((s.store[s.tid] || []).length || this.setupPending) return;
    this.setupPending = true;
    this.run('system.status…', () => { this.setupPending = false; this.push({ kind: 'setup' }); }, 700);
  }
  tool(names) { return 'used ' + names + (this.state.judge ? ' · judge allowed' : ''); }
  later(fn, ms) { this.timers.push(setTimeout(fn, ms)); }
  push(m) {
    const msg = { id: 'm' + (++this.seq), ...m };
    this.setState((s) => ({ store: { ...s.store, [s.tid]: [...(s.store[s.tid] || []), msg] } }));
    return msg.id;
  }
  patch(id, p) {
    this.setState((s) => ({ store: { ...s.store, [s.tid]: (s.store[s.tid] || []).map((m) => (m.id === id ? { ...m, ...p } : m)) } }));
  }
  run(status, fn, ms = 900) {
    this.setState({ busy: status });
    this.later(() => { this.setState({ busy: '' }); fn(); }, ms);
  }

  send(text, spoken) {
    const t = (text || '').trim();
    if (!t || this.state.busy) return;
    this.setState((s) => ({
      draft: '', spokenDraft: false, menu: null,
      threads: s.threads.map((th) => (th.id === s.tid && th.title === 'New thread' ? { ...th, title: t.length > 44 ? t.slice(0, 44) + '…' : t } : th)),
    }));
    this.push({ kind: 'user', text: t, spoken: !!spoken });
    this.route(t);
  }

  route(t) {
    const l = t.toLowerCase();
    const url = /github\.com\/([\w.-]+\/[\w.-]+)/.exec(l);
    if (url) return this.check(url[1]);
    if (/workflow/.test(l)) return this.run('workflow.list…', () => this.push({ kind: 'workflows' }));
    if (/decision|judge/.test(l)) return this.run('system.status…', () => this.push({ kind: 'answer', text: this.state.judge
      ? 'A decision model is set up (system-one, self-hosted). It reviews every tool call before it runs, reads included. If it is down or slow, the action asks you. Approving gates and granting agent permissions always ask, whatever it says.'
      : 'No decision model is configured, so the fixed table decides: reads and draft edits run, anything that creates real state asks you. To add one, set COMMUNICATION_DECISION_BASE_URL (a /v1/system-one endpoint) and COMMUNICATION_DECISION_MODEL, or add it under Settings → Assistant.', tool: this.tool('system.status') }));
    if (/(repo|project)/.test(l) && /(add|new|create|connect)/.test(l)) return this.startAdd();
    if (/(token|credential|github|secret)/.test(l)) return this.run('credential.list…', () => this.push({ kind: 'creds' }));
    if (/(\bthis\b|\bhere\b|stuck|\bit\b|page)/.test(l)) return this.contextAnswer();
    return this.run('thinking…', () => this.push({ kind: 'answer', text: 'In the real build this goes to the chat model. In this prototype, try asking about workflows, GitHub tokens, adding a repo, the decision model, or "is anything stuck here?"' }), 600);
  }

  contextAnswer() {
    const s = this.state;
    const p = this.PAGES[s.page];
    if (!s.ctxOn) return this.run('thinking…', () => this.push({ kind: 'answer', text: 'Which one do you mean? Page context is off, so I can\u2019t see what you have open.' }), 600);
    const text = {
      today: 'Nothing on Today is stuck. No runs are waiting on anyone, because there are no projects yet.',
      workflows: 'Nothing is stuck. None of these workflows is running, because none is assigned to a project.',
      homelab: 'Nothing is stuck on home-lab. It has no workflow, so nothing has run yet.',
    }[s.page] || ('Nothing on ' + p.label + ' is waiting on you right now.');
    this.run('run.list…', () => this.push({ kind: 'answer', text, hasCtx: true, ctx: 'assumed you meant the ' + p.label + ' page (on screen)', tool: this.tool('run.list') }));
  }

  startAdd = () => {
    if (this.state.busy) return;
    this.run('credential.list…', () => {
      this.push({ kind: 'answer', text: 'Paste a GitHub URL, or pick a repo GITHUB_TOKEN can see. I\u2019ll check access before anything is created.', tool: this.tool('credential.list') });
      const id = this.push({ kind: 'question', prompt: 'Which repository?', options: ['dbirks/home-lab', 'dbirks/communication', 'Paste a URL…'], answered: false, picked: null });
      this.lastQ = id;
    }, 700);
  };

  pick(qid, label) {
    this.patch(qid, { answered: true, picked: label });
    if (label === 'Paste a URL…') {
      this.setState({ draft: 'github.com/' });
      this.later(() => this.inputRef.current && this.inputRef.current.focus(), 50);
      return;
    }
    this.push({ kind: 'user', text: label });
    this.check(label);
  }

  check(repo) {
    const project = repo.split('/')[1];
    this.run('repo.check github.com/' + repo + '…', () => {
      this.push({ kind: 'answer', text: 'GITHUB_TOKEN can read and push to ' + repo + '. Default branch is main.', tool: this.tool('repo.check') });
      const s = this.state;
      if (s.trust === 'none') return this.doCreate(null, project, repo, true);
      const reason = s.trust === 'all'
        ? 'Your level asks before every change.'
        : s.judge
          ? 'Flagged by the decision model.'
          : 'Creates real state.';
      this.push({ kind: 'proposal', project, repo, reason, state: 'pending' });
    }, 1100);
  }

  doCreate(mid, project, repo, unasked) {
    if (mid) this.patch(mid, { state: 'done' });
    this.run('project.create · repo.add…', () => {
      this.setState((s) => ({ created: true, changes: [...s.changes, { text: 'Created project ' + project, meta: (unasked ? 'ran without asking' : 'you confirmed') + ' · can\u2019t be undone here' }, { text: 'Connected ' + repo + ' @ main', meta: 'with GITHUB_TOKEN' }] }));
      this.push({ kind: 'answer', text: 'Created ' + project + ' and connected ' + repo + ' @ main. It has no workflow yet. Want feature-delivery on it? (This prototype stops here; the real build would propose assignment.set next.)', tool: 'used project.create, repo.add' + (unasked ? ' · ran without asking (Don\u2019t ask)' : '') });
    }, 900);
  }

  onMic = () => {
    const s = this.state;
    if (s.mic === 'idle') {
      this.setState({ mic: 'rec', micSecs: 0, menu: null });
      this.micTimer = setInterval(() => this.setState((x) => ({ micSecs: x.micSecs + 1 })), 1000);
    } else if (s.mic === 'rec') {
      clearInterval(this.micTimer);
      this.setState({ mic: 'trans' });
      this.later(() => {
        this.setState((x) => {
          const words = this.PHRASES[x.phrase % this.PHRASES.length];
          const d = x.draft.trim();
          return { mic: 'idle', draft: d ? d + ' ' + words : words, spokenDraft: true, phrase: x.phrase + 1 };
        });
        if (this.props.autoSendDictation) this.later(() => this.send(this.state.draft, true), 50);
        else this.inputRef.current && this.inputRef.current.focus();
      }, 1100);
    }
  };

  newThread = () => {
    const id = 't' + Date.now();
    this.setState((s) => ({ threads: [{ id, title: 'New thread', age: 'now' }, ...s.threads.filter((t) => !(t.title === 'New thread' && (s.store[t.id] || []).length === 0))], store: { ...s.store, [id]: [] }, tid: id, menu: null, draft: '', changes: [] }), () => this.ensureSetup());
  };

  renderVals() {
    const s = this.state;
    const page = this.PAGES[s.page];
    const mode = s.mode;
    const isPopover = mode === 'popover', isDock = mode === 'dock', isPage = mode === 'page';
    const msgs = s.store[s.tid] || [];
    const go = (p) => () => this.setState({ page: p, ...(isPage ? { mode: 'popover' } : {}) });
    const nav = (key, label, count) => ({ label, count: count || '', active: s.page === key && !(s.open && isPage), inactive: !(s.page === key && !(s.open && isPage)), go: go(key) });
    const ib = { width: 26, height: 26, display: 'grid', placeItems: 'center', border: 'none', borderRadius: 4, background: 'transparent', color: '#3a3833', cursor: 'pointer' };
    const ibOn = { ...ib, background: '#e6e2d9', color: '#1e1d1a' };

    const checklist = [
      { ok: true, label: 'Chat model', meta: 'qwen3-8-flash-next' },
      { ok: true, label: 'Speech model', meta: 'qwen3-asr' },
      s.judge ? { ok: true, label: 'Decision model', meta: 'system-one · self-hosted' } : { warn: true, label: 'No decision model', meta: '', hasAction: true, action: 'Set up', act: () => this.send('how do I set up the decision model?') },
      { ok: true, label: '1 worker online', meta: 'nono required' },
      { ok: true, label: 'GitHub credential', meta: s.created ? 'GITHUB_TOKEN · 1 project' : 'GITHUB_TOKEN · unused', hasAction: !s.created, action: 'Check', act: () => this.send('do you have access to any github tokens?') },
      s.created ? { ok: true, label: '1 project', meta: 'home-lab' } : { todo: true, label: 'No projects yet', meta: '', hasAction: true, action: 'Add one', act: () => this.send('help me add my first project') },
      { todo: true, label: '3 workflows, none assigned', meta: '', hasAction: true, action: 'Show', act: () => this.send('what workflows do I have?') },
    ];
    const tryRows = ['What workflows do I have?', 'Any GitHub tokens?', 'Is anything stuck here?'].map((text) => ({ text, go: () => this.send(text) }));

    const view = msgs.map((m) => {
      const v = { id: m.id };
      if (m.kind === 'user') Object.assign(v, { user: true, text: m.text, spoken: m.spoken });
      if (m.kind === 'answer') Object.assign(v, { answer: true, text: m.text, hasCtx: !!m.hasCtx, ctx: m.ctx, hasTool: !!m.tool, tool: m.tool });
      if (m.kind === 'setup') Object.assign(v, { setup: true, rows: checklist, tries: tryRows, tool: this.tool('system.status') });
      if (m.kind === 'workflows') v.workflows = true;
      if (m.kind === 'creds') v.creds = true;
      if (m.kind === 'question') Object.assign(v, {
        question: true, prompt: m.prompt, answered: m.answered,
        options: m.options.map((o) => ({ label: o, weight: m.picked === o ? 700 : 500, edge: m.picked === o ? '#1e1d1a' : '#cfc9bd', go: () => !m.answered && this.pick(m.id, o) })),
      });
      if (m.kind === 'proposal') Object.assign(v, {
        proposal: true, project: m.project, repo: m.repo, reason: m.reason,
        banner: m.state === 'pending' ? 'NEEDS YOUR OK · CREATES REAL STATE' : m.state === 'done' ? 'CONFIRMED' : 'DISMISSED',
        pending: m.state === 'pending', done: m.state === 'done', dropped: m.state === 'dropped',
        create: () => this.doCreate(m.id, m.project, m.repo, false),
        dismiss: () => { this.patch(m.id, { state: 'dropped' }); this.push({ kind: 'answer', text: 'OK, nothing was created.' }); },
      });
      return v;
    });

    const trustDefs = [
      { v: 'all', label: 'Ask before every change', pill: 'ask every change', blurb: 'You confirm every change.' },
      { v: 'judge', label: 'Ask when it looks risky', pill: 'ask when risky', isDefault: true, blurb: 'A decision model checks each call. Flagged ones wait for you.' },
      { v: 'none', label: 'Don\u2019t ask', pill: 'don\u2019t ask', blurb: 'Everything runs. Each action is listed in the thread.' },
    ];
    const tcur = trustDefs.find((t) => t.v === s.trust);

    const micIdle = s.mic === 'idle', micRec = s.mic === 'rec', micTrans = s.mic === 'trans';
    const btn30 = { width: 30, height: 30, display: 'grid', placeItems: 'center', borderRadius: 4, cursor: 'pointer', flexShrink: 0 };
    const micStyle = micRec
      ? { ...btn30, color: '#fff', background: '#c02a1a', border: '1px solid #7f2215' }
      : micTrans
        ? { ...btn30, color: '#b3ada2', background: '#f3f1ec', border: '1px solid #e6e2d9', cursor: 'default' }
        : { ...btn30, color: '#1e1d1a', background: '#efede7', border: '1px solid #cfc9bd', boxShadow: '2px 2px 0 #cfc9bd' };
    const cantSend = !s.draft.trim() || !!s.busy || !micIdle;
    const sendStyle = cantSend
      ? { ...btn30, color: '#b3ada2', background: '#f3f1ec', border: '1px solid #e6e2d9', cursor: 'not-allowed' }
      : { ...btn30, color: '#fff', background: '#2f4bd6', border: '1px solid #2238a8', boxShadow: '2px 2px 0 #1a2d8f' };

    const wave = React.createElement('span', { style: { display: 'flex', alignItems: 'center', gap: 2, height: 14, flex: 1 } },
      Array.from({ length: 28 }, (_, i) => React.createElement('span', { key: i, style: { width: 3, height: '100%', borderRadius: 1, background: '#2f4bd6', animation: 'ptbar 1.1s ease-in-out infinite', animationDelay: (i * 0.07) + 's' } })));

    const threadRows = s.threads.map((t) => ({ title: t.title, age: t.age, active: t.id === s.tid, bg: t.id === s.tid ? '#f6f7fe' : 'transparent', weight: t.id === s.tid ? 600 : 400, go: () => this.setState({ tid: t.id, menu: null }) }));
    const threadTitle = (s.threads.find((t) => t.id === s.tid) || {}).title || 'New thread';

    const wrapStyle = isPopover
      ? { position: 'fixed', right: 16, bottom: 16, zIndex: 40, display: 'flex', flexDirection: 'column', alignItems: 'flex-end' }
      : isDock
        ? { position: 'fixed', top: 0, right: 0, bottom: 0, width: 450, zIndex: 40, display: 'flex', borderLeft: '1px solid #1e1d1a', background: '#fff' }
        : { position: 'fixed', top: 0, right: 0, bottom: 0, left: 220, zIndex: 40, display: 'flex', background: '#fff' };
    const holderStyle = isPopover
      ? { position: 'relative', width: 400, maxWidth: 'calc(100vw - 32px)' }
      : { position: 'relative', flex: '1 1 auto', minWidth: 0, height: '100%' };
    const panelStyle = isPopover
      ? { maxHeight: 'min(72vh, 600px)', display: 'flex', flexDirection: 'column', background: '#fff', border: '1px solid #1e1d1a', borderRadius: 4, boxShadow: '2px 2px 0 #1e1d1a', overflow: 'hidden' }
      : { height: '100%', display: 'flex', flexDirection: 'column', background: '#fff' };
    const headerStyle = {
      display: 'flex', alignItems: 'center', gap: 4, padding: isPage ? '10px 16px' : '6px 8px 6px 10px', flexShrink: 0,
      background: isPage ? '#fff' : '#efede7', borderBottom: '1px solid #e6e2d9',
    };
    const colStyle = isPage ? { maxWidth: 720, margin: '0 auto', padding: '8px 16px' } : {};
    const composerOuter = isPage
      ? { padding: '10px 16px 18px', flexShrink: 0, maxWidth: 752, width: '100%', margin: '0 auto' }
      : { padding: 8, borderTop: '1px solid #e6e2d9', flexShrink: 0 };
    const vw = s.vw || 1440;
    const showThreadCol = isPage && vw >= 1000;
    const showCtxCol = isPage && vw >= 1240;
    const H = isPage ? 47 : 39;
    const rp = isPage ? 16 : 8;
    const tc = rp + 103;
    const rowTop = isPage ? 57 : 47;
    const holderW = isPage ? vw - 220 - (showThreadCol ? 240 : 0) - (showCtxCol ? 260 : 0) : 400;
    const base = isPage ? Math.max(0, (holderW - Math.min(752, holderW)) / 2) + 25 : 17;
    const box = { position: 'absolute', zIndex: 40, background: '#fff', border: '1px solid #1e1d1a', borderRadius: 4, boxShadow: '2px 2px 0 #1e1d1a', padding: 8, display: 'flex', flexDirection: 'column', gap: 2 };
    const arrowUp = { position: 'absolute', zIndex: 41, width: 9, height: 9, background: '#fff', borderTop: '1px solid #1e1d1a', borderLeft: '1px solid #1e1d1a', transform: 'rotate(45deg)' };
    const arrowDown = { position: 'absolute', zIndex: 41, width: 9, height: 9, background: '#fff', borderBottom: '1px solid #1e1d1a', borderRight: '1px solid #1e1d1a', transform: 'rotate(45deg)' };
    const menuPos = {
      threadsBox: { ...box, top: H + 5, right: rp, width: 300 },
      threadsArrow: { ...arrowUp, top: H + 1, right: tc - 4.5 },
      ctxBox: { ...box, gap: 6, bottom: rowTop + 8, left: Math.max(6, base - 2), width: 270 },
      ctxArrow: { ...arrowDown, bottom: rowTop + 4, left: base + 13 - 4.5 },
      trustBox: { ...box, bottom: rowTop + 8, left: base + 22, width: 290 },
      trustArrow: { ...arrowDown, bottom: rowTop + 4, left: base + 90 - 4.5 },
    };
    const composerBox = { minWidth: 0, border: '1px solid ' + (micRec ? '#8fa0e6' : '#cfcac0'), borderStyle: micRec ? 'dashed' : 'solid', background: micRec ? '#f6f7fe' : '#fff', borderRadius: 4, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 };
    const mainStyle = { flex: '1 1 auto', minWidth: 0, marginRight: s.open && isDock ? 450 : 0 };

    return {
      page, open: s.open, isPopover, isDock, isPage, notPopover: !isPopover, notPage: !isPage,
      showThreadCol, showCtxCol, showThreadBtns: !showThreadCol, ...menuPos,
      showFab: !s.open,
      openAsk: () => this.setState({ open: true }, () => this.ensureSetup()),
      close: () => this.setState({ open: false, menu: null }),
      navTop: [nav('today', 'Today'), nav('catchup', 'Catch up'), nav('threads', 'Threads')],
      navLib: [nav('workflows', 'Workflows', '3'), nav('agents', 'Agents', '2')],
      noProjects: !s.created, created: s.created, goHomelab: go('homelab'),
      mainStyle, wrapStyle, holderStyle, panelStyle, headerStyle, colStyle, composerOuter, composerBox,
      threadTitle, threadRows, newThread: this.newThread,
      threadsMenu: s.menu === 'threads',
      toggleThreads: () => this.setState((x) => ({ menu: x.menu === 'threads' ? null : 'threads' })),
      threadsBtnStyle: s.menu === 'threads' ? ibOn : ib,
      dockTitle: isDock ? 'Back to popover' : 'Open as side panel',
      dockBtnStyle: isDock ? ibOn : ib,
      toggleDock: () => this.setState((x) => ({ mode: x.mode === 'dock' ? 'popover' : 'dock', menu: null })),
      pageTitle: isPage ? 'Exit full page' : 'Open full page',
      pageIcon: isPage ? 'ti ti-arrows-diagonal-minimize-2' : 'ti ti-arrows-diagonal',
      togglePage: () => this.setState((x) => ({ mode: x.mode === 'page' ? 'popover' : 'page', menu: null })),
      bodyRef: this.bodyRef, inputRef: this.inputRef,
      isEmpty: msgs.length === 0, checklist, tryRows, msgs: view,
      workflowRows: [{ name: 'feature-delivery', meta: 'v4 · yours' }, { name: 'issue-triage', meta: 'sample' }, { name: 'review-only', meta: 'sample' }],
      credUse: s.created ? 'Used by home-lab' : 'Used by 0 projects',
      startAdd: this.startAdd,
      busy: s.busy, hasBusy: !!s.busy,
      draft: s.draft,
      onDraft: (e) => this.setState({ draft: e.target.value }),
      onKeyDown: (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.send(this.state.draft, this.state.spokenDraft); } },
      sendDraft: () => this.send(s.draft, s.spokenDraft), cantSend, sendStyle,
      micRec, micTrans, micStyle, onMic: this.onMic, wave,
      micIcon: micRec ? 'ti ti-player-stop' : 'ti ti-microphone',
      micTitle: micRec ? 'Stop and transcribe' : micTrans ? 'Transcribing…' : 'Dictate (adds to the end)',
      micTime: Math.floor(s.micSecs / 60) + ':' + String(s.micSecs % 60).padStart(2, '0'),
      ctxOn: s.ctxOn, ctxMenu: s.menu === 'ctx',
      ctxIcon: s.ctxOn ? 'ti ti-current-location' : 'ti ti-current-location-off',
      ctxTitle: s.ctxOn ? 'Page context: ' + page.label : 'Page context off',
      ctxBtnStyle: { ...ib, border: '1px solid ' + (s.menu === 'ctx' ? '#1e1d1a' : '#e6e2d9'), color: s.ctxOn ? '#2a43b8' : '#6e6a62', background: s.ctxOn ? '#f6f7fe' : '#fff' },
      toggleCtxMenu: () => this.setState((x) => ({ menu: x.menu === 'ctx' ? null : 'ctx' })),
      toggleCtx: () => this.setState((x) => ({ ctxOn: !x.ctxOn })),
      checkStyle: s.ctxOn
        ? { width: 14, height: 14, marginTop: 2, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 2, background: '#2f4bd6', border: '1px solid #2238a8' }
        : { width: 14, height: 14, marginTop: 2, flexShrink: 0, display: 'grid', placeItems: 'center', borderRadius: 2, background: '#fff', border: '1px solid #6b675e' },
      trustLabel: tcur.pill, trustMenu: s.menu === 'trust',
      toggleTrust: () => this.setState((x) => ({ menu: x.menu === 'trust' ? null : 'trust' })),
      trustOptions: trustDefs.map((t) => ({ ...t, isDefault: !!t.isDefault, checked: t.v === s.trust, bg: t.v === s.trust ? '#f6f7fe' : 'transparent', go: () => this.setState({ trust: t.v, menu: null }) })),
      judgeLine: s.judge ? 'system-one · self-hosted · if down, asks you' : 'none set up · fixed table decides',
      ctxSideLabel: s.ctxOn ? page.label : 'Page context off',
      ctxSideMeta: s.ctxOn ? page.route : '',
      changes: s.changes, noChanges: s.changes.length === 0,
      trustSummary: tcur.label,
    };
  }
}
