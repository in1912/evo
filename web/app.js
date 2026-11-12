/* 衍像｜EvolveShot — 前端（Vue3 全局构建，无构建步骤，hash 路由） */
(function () {
  const { createApp, reactive, computed, watch, onMounted } = Vue;

  // ---------- 工具 ----------
  const basename = (p) => String(p || '').split(/[\\/]/).pop();
  const fmtTime = (s) => { if (!s) return '-'; const d = new Date(String(s).replace(' ', 'T')); return isNaN(d) ? s : d.toLocaleString('zh-CN', { hour12: false }); };
  const bytes = (n) => { n = Number(n) || 0; if (n < 1024) return n + 'B'; if (n < 1048576) return (n / 1024).toFixed(1) + 'KB'; if (n < 1073741824) return (n / 1048576).toFixed(1) + 'MB'; return (n / 1073741824).toFixed(2) + 'GB'; };

  // ---------- API ----------
  const token = () => localStorage.getItem('evolveshot_token') || '';
  async function api(method, path, body) {
    const t = token();
    const headers = {};
    if (t) headers['Authorization'] = 'Bearer ' + t;
    const opts = { method, headers };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    // v1.0.13：token 同时走查询参数——个别代理/网关会剥 Authorization 头（2026-11-06 公网
    // 访问「登录成功又弹回登录框」的根因之一）；服务端 extractToken 两种都认（媒体文件一直用 ?token=）
    let url = '/api' + path;
    if (t) url += (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t);
    const r = await fetch(url, opts);
    if (r.status === 401) {
      // v1.0.13：只有「这次失败的仍是当前这份 token」才登出——别的标签页/旧请求的 401
      // 不许清掉别人刚登录好的新 token（曾导致要连续登录四五次）
      if (!t || token() === t) store.logout();
      throw new Error('登录已过期，请重新登录');
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
    return data;
  }
  async function apiBlob(method, path, body) {
    const headers = { 'Authorization': 'Bearer ' + token() };
    if (body !== undefined) { headers['Content-Type'] = 'application/json'; }
    const r = await fetch('/api' + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || ('HTTP ' + r.status)); }
    return r.blob();
  }

  // ---------- 全局状态 ----------
  const store = reactive({
    user: null,
    route: (location.hash || '#/generate').replace(/^#\/?/, '') || 'generate',
    theme: localStorage.getItem('evolveshot_theme') || 'day',
    loading: false,
    async init() {
      if (!token()) return;
      // v1.0.13：启动拿用户信息失败先重试（网络/代理抖动不该直接把人踢回登录页）；
      // 真 401（token 确实失效）由 api() 走登出
      for (let i = 0; i < 3; i++) {
        try { const d = await api('GET', '/auth/me'); store.user = d.user; return; }
        catch (e) {
          if (String(e.message || '').includes('登录已过期')) return;
          await new Promise((r) => setTimeout(r, 600 * (i + 1)));
        }
      }
    },
    setTheme(t) { store.theme = t; document.documentElement.dataset.theme = t; localStorage.setItem('evolveshot_theme', t); },
    logout() { localStorage.removeItem('evolveshot_token'); store.user = null; location.hash = '#/login'; },
    nav(to) { location.hash = '#/' + to; },
    comfyStatus: { running: false, mode: 'local', url: '', device: '' },
    async refreshComfy() {
      if (!store.user) return;
      try { store.comfyStatus = await api('GET', '/generate/status'); }
      catch (e) { store.comfyStatus = { running: false, mode: 'local', url: '', device: '' }; }
    },
  });

  // 认证文件 URL（<video>/<audio>/<img> 带不了 Authorization，走 ?token=）
  const authed = (path) => path + (path.includes('?') ? '&' : '?') + 'token=' + token();

  // v1.0.34 生成页排队提醒；v1.0.42 修复：查忙必须查「提交之前」的状态——原实现提交后再查，
  // 自己刚提交的任务瞬间已被后端记成 running，空队列也永远提示「有 1 个任务」。
  // 用法：提交前 const _busy = await busyBefore(); 提交成功后 queueBusyNotice(_busy)。
  async function busyBefore() {
    try { return Number((await api('GET', '/tasks/busy')).running) || 0; } catch (e) { return null; }
  }
  function queueBusyNotice(preRunning) {
    if (preRunning && preRunning > 0)
      alert(`当前有 ${preRunning} 个任务正在执行，本任务已进入队列排队，稍后自动排队执行。`);
  }

  // v1.0.35 常用尺寸预设（文生图/广告图「尺寸」下拉共用，matchPreset 供换算后反查选中项）
  const SIZE_PRESETS = [
    { v: '960x540', label: '960×540（qHD）' },
    { v: '1280x720', label: '1280×720（HD）' },
    { v: '1920x1080', label: '1920×1080（FHD）' },
    { v: '2560x1440', label: '2560×1440（QHD / 2K）' },
    { v: '3840x2160', label: '3840×2160（UHD 4K）' },
    { v: '2560x1600', label: '2560×1600（16:10：WQXGA）' },
    { v: '3440x1440', label: '3440×1440（21:9 UWQHD）' },
  ];
  const matchPreset = (w, h) => { const k = Number(w) + 'x' + Number(h); return SIZE_PRESETS.some((s) => s.v === k) ? k : ''; };
  // v1.0.41 负向提示词快捷词组（文生图/广告图共用；追加式，可两组叠加）
  const NEG_PRESETS = {
    person: '两个女人，两位女性，双人，多人，人群中重复的人，双胞胎，镜像人物，前景多余的女性，第二个女人，拼贴，分屏，双重曝光，重复的人物，抹胸露胸，胸部裸露，露肩过度低胸，内衣外露，短袖T恤，外套，开衫，长裤，牛仔裤，浓妆，厚重腮红，油光满面，过度磨皮，塑料皮肤，磨皮失真，欧美面孔，外国脸，混血，文字，水印，logo，签名，边框，低质量，畸形手指，多余手指，错乱的肢体，断手，融合的手指',
    ad: '文字，水印，logo，签名，边框，杂乱文字，扭曲，畸形，变形，崩坏，模糊，低分辨率，噪点，脏污，灰暗，暗沉，刺眼强光，硬阴影，锐利阴影，写实恐怖，暗黑，压抑，破败，老旧，粗糙纹理，杂乱多余物体，多出来的肢体，残缺，错位，交叉线条，杂乱电线，土味配色，高饱和刺眼荧光色，人物，小动物，丑陋，丑陋花朵，破碎建筑，浑浊发黑海水，泡沫杂乱，构图拥挤，裁切不全，水印，字幕，二维码',
  };

  // ---------- 登录页动态星空（移植自工作台 Login.vue：canvas 星星 + 鼠标吸引流星跟随 + 闪烁，昼夜配色） ----------
  function setupStarfield(canvas) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    let W = 0, H = 0;
    const resize = () => {
      // 用视口尺寸而非元素尺寸：挂载瞬间元素布局可能未定型（实测曾量到 428px 的收缩宽度，星空被横向拉扁）
      W = window.innerWidth || canvas.clientWidth;
      H = window.innerHeight || canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener('resize', resize);
    const wantCount = () => Math.min(320, Math.floor(W * H / 3800));
    const newStar = () => ({
      x: Math.random() * W, y: Math.random() * H,
      r: Math.random() * 1.6 + 0.4, a: Math.random() * 0.65 + 0.25,
      sp: Math.random() * 0.35 + 0.08, phase: Math.random() * Math.PI * 2,
      tw: Math.random() * 0.03 + 0.008, vx: 0, vy: 0,
      big: Math.random() < 0.12,
    });
    let stars = Array.from({ length: wantCount() }, newStar);
    // 帧末再校准一次尺寸并补足星星（挂载后布局才最终定型）
    requestAnimationFrame(() => { resize(); while (stars.length < wantCount()) stars.push(newStar()); });
    const mouse = { x: -9999, y: -9999 };
    const onMove = (e) => { mouse.x = e.clientX; mouse.y = e.clientY; };
    const onTouch = (e) => { if (e.touches[0]) { mouse.x = e.touches[0].clientX; mouse.y = e.touches[0].clientY; } };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('touchmove', onTouch, { passive: true });
    const starColor = (a, big) => {
      const light = (document.documentElement.dataset.theme || 'day') !== 'night';
      if (big) return light ? `rgba(20,60,130,${a})` : `rgba(190,215,255,${a})`;
      return light ? `rgba(35,70,140,${a})` : `rgba(255,255,255,${a})`;
    };
    let raf = 0;
    const tick = (t) => {
      ctx.clearRect(0, 0, W, H);
      for (const s of stars) {
        const dx = mouse.x - s.x, dy = mouse.y - s.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 170 && dist > 0.001) {
          // 星星被鼠标吸引，加速冲向鼠标 → 流星跟随效果
          const force = (170 - dist) / 170 * 0.9;
          s.vx += (dx / dist) * force * 1.6;
          s.vy += (dy / dist) * force * 1.6;
        } else {
          s.vx *= 0.94; s.vy *= 0.94; // 恢复自然浮动
        }
        s.x += s.vx + Math.sin(t * 0.0002 + s.phase) * 0.18;
        s.y += s.vy + s.sp;
        if (s.y > H + 6) { s.y = -6; s.x = Math.random() * W; s.vx = 0; s.vy = 0; }
        if (s.x < -6) s.x = W + 6;
        if (s.x > W + 6) s.x = -6;
        const alpha = s.a * (0.65 + 0.35 * Math.sin(t * s.tw + s.phase));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = starColor(alpha, s.big);
        ctx.fill();
        if (s.big) { // 大星星带一圈淡光晕
          ctx.beginPath();
          ctx.arc(s.x, s.y, s.r * 3, 0, Math.PI * 2);
          ctx.fillStyle = starColor(alpha * 0.18, false);
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('touchmove', onTouch);
    };
  }

  // ---------- 进度计时混入（三个生成页共用，v1.0.13）----------
  // 耗时显示 = 现在 - t0（提交时刻）；t0 可传任务 created_at 时间戳用于「接着显示别人的在跑任务」
  const clockMixin = {
    data() { return { t0: 0, nowTick: 0, tTimer: null }; },
    computed: {
      // nowTick 每秒 +1 是唯一的响应式依赖：Date.now() 不触发重算，缺了它 elapsedText
      // 会被 Vue 缓存成首次渲染的 0:00 永远不动（v1.0.13「耗时一直是 0」的根因）
      elapsedMs() { void this.nowTick; return this.t0 ? Math.max(0, Date.now() - this.t0) : 0; },
      elapsedText() {
        if (!this.t0) return '';
        const s = Math.floor(this.elapsedMs / 1000);
        const m = Math.floor(s / 60), h = Math.floor(m / 60);
        return '已耗时 ' + (h ? h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
          : m + ':' + String(s % 60).padStart(2, '0'));
      },
    },
    methods: {
      startClock(fromTs) {
        this.t0 = fromTs && fromTs > 0 ? fromTs : Date.now();
        if (!this.tTimer) this.tTimer = setInterval(() => { this.nowTick++; }, 1000);
      },
      stopClock() { this.tTimer && clearInterval(this.tTimer); this.tTimer = null; },
      fmtClock(ms) {
        if (!ms || ms <= 0) return '';
        const s = Math.floor(ms / 1000), m = Math.floor(s / 60), h = Math.floor(m / 60);
        return h ? h + ':' + String(m % 60).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0')
          : m + ':' + String(s % 60).padStart(2, '0');
      },
    },
    beforeUnmount() { this.stopClock(); },
  };

  // ---------- 需求28 粘贴图片弹窗（全局组件，各上传位共用） ----------
  // 打开后监听 document 的 paste 事件：Ctrl+V 粘贴剪贴板图片（截图 Win+Shift+S / PrtScn 直接粘）。
  // multi=false 单槽——新粘覆盖旧图；multi=true 多张——连续粘贴累积。确定后把整组交给页面（含 data=base64）。
  const PasteDlg = {
    props: { title: { type: String, default: '粘贴图片' }, multi: { type: Boolean, default: false } },
    template: `
    <div class="overlay" @click.self="$emit('close')">
      <div class="card" style="max-width:760px;width:92vw;max-height:82vh;overflow:auto">
        <h3 style="margin:0 0 8px">{{ title }}</h3>
        <div class="muted" style="font-size:12px;margin-bottom:10px">按 Ctrl+V 粘贴剪贴板里的图片{{ multi ? '，可连续粘贴多张' : '；再次粘贴会替换当前图' }}（截图 Win+Shift+S 后直接粘贴即可）。</div>
        <div v-if="!items.length" style="padding:40px;text-align:center;border:1px dashed var(--border);border-radius:8px;opacity:.7">还没有粘贴图片——按 Ctrl+V 试试</div>
        <div v-else style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px">
          <div v-for="(it, i) in items" :key="it.key" style="position:relative;border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:4px;text-align:center">
            <img :src="it.dataUrl" style="width:100%;height:96px;object-fit:cover;border-radius:4px" />
            <div style="font-size:11px;opacity:.65;margin-top:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ it.name }}</div>
            <button class="btn sm" style="position:absolute;top:2px;right:2px;padding:0 6px;line-height:20px" @click="rm(i)" title="移除此图">✕</button>
            <div v-if="multi && items.length > 1" style="position:absolute;left:2px;top:2px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;border-radius:4px;padding:0 5px;line-height:18px" :title="'第 ' + (i + 1) + ' 张'">{{ i + 1 }}</div>
          </div>
        </div>
        <div style="margin-top:12px;display:flex;gap:10px;justify-content:flex-end;align-items:center">
          <span class="muted" style="flex:1;font-size:12px">{{ items.length ? '共 ' + items.length + ' 张' + (multi ? '（按粘贴顺序）' : '') : '' }}</span>
          <button v-if="items.length" class="btn sm" @click="items = []">清空</button>
          <button class="btn sm" @click="$emit('close')">取消</button>
          <button class="btn primary" :disabled="!items.length" @click="ok">确定（{{ items.length }} 张）</button>
        </div>
      </div>
    </div>`,
    data() { return { items: [], seq: 0 }; },
    mounted() {
      this._onPaste = (e) => {
        let got = false;
        for (const it of (e.clipboardData && e.clipboardData.items) || []) {
          if (it.kind !== 'file' || !/^image\//.test(it.type || '')) continue;
          const f = it.getAsFile(); if (!f) continue;
          got = true;
          const raw = (f.type || 'image/png').split('/')[1] || 'png';
          const ext = ({ jpeg: 'jpg', 'svg+xml': 'svg' })[raw] || raw;
          const seq = ++this.seq;
          const r = new FileReader();
          r.onload = () => {
            const item = { key: 'p' + seq, name: f.name && f.name !== 'image.png' ? f.name : ('粘贴' + seq + '.' + ext), dataUrl: r.result, ext, data: r.result };
            if (this.multi) { if (this.items.length < 30) this.items.push(item); }
            else this.items = [item];   // 单槽：新粘覆盖旧图
          };
          r.readAsDataURL(f);
        }
        if (got) e.preventDefault();
      };
      document.addEventListener('paste', this._onPaste);
    },
    beforeUnmount() { document.removeEventListener('paste', this._onPaste); },
    methods: {
      rm(i) { this.items.splice(i, 1); },
      ok() { this.$emit('confirm', this.items.map((x) => ({ name: x.name, dataUrl: x.dataUrl, ext: x.ext, data: x.dataUrl }))); },
    },
  };

  // ---------- 登录 ----------
  const Login = {
    template: `
    <div class="login-wrap">
      <canvas ref="cv" class="star-canvas"></canvas>
      <div class="login-card">
        <div class="brand">
          <div class="logo-row" style="justify-content:center;margin-bottom:6px"><span class="material-icons" style="font-size:34px;color:var(--primary)">movie_filter</span></div>
          <h1>衍像｜EvolveShot</h1><div class="sub">图生视频 · 语音克隆配音</div>
        </div>
        <div v-if="err" class="alert err">{{ err }}</div>
        <div class="field"><label>用户名</label><input v-model="username" @keyup.enter="doLogin" autocomplete="username" /></div>
        <div class="field"><label>密码</label><input type="password" v-model="password" @keyup.enter="doLogin" autocomplete="current-password" /></div>
        <button class="btn primary" style="width:100%" :disabled="busy" @click="doLogin">{{ busy ? '登录中…' : '登录' }}</button>
        <div class="muted" style="text-align:center;margin-top:14px">
          没有账号？<a href="javascript:void 0" @click="showReg = !showReg">注册（需邀请码）</a>
        </div>
        <template v-if="showReg">
          <hr style="border:none;border-top:1px solid var(--border);margin:16px 0" />
          <div class="field"><label>用户名</label><input v-model="ruser" /></div>
          <div class="field"><label>密码</label><input type="password" v-model="rpass" /></div>
          <div class="field"><label>邀请码</label><input v-model="rinvite" placeholder="8 位邀请码，请联系管理员获取" style="text-transform:uppercase" /></div>
          <div class="field"><label>昵称（可选）</label><input v-model="rname" /></div>
          <button class="btn" style="width:100%" :disabled="busy" @click="doRegister">注册</button>
        </template>
      </div>
    </div>`,
    data() { return { username: '', password: '', busy: false, err: '', showReg: false, ruser: '', rpass: '', rname: '', rinvite: '' }; },
    mounted() { this._cleanupStars = this.$refs.cv ? setupStarfield(this.$refs.cv) : null; },
    beforeUnmount() { if (this._cleanupStars) this._cleanupStars(); },
    methods: {
      async doLogin() {
        this.err = ''; this.busy = true;
        try {
          const d = await api('POST', '/auth/login', { username: this.username, password: this.password });
          localStorage.setItem('evolveshot_token', d.token);
          store.user = d.user;
          location.hash = '#/generate';
        } catch (e) { this.err = e.message; } finally { this.busy = false; }
      },
      async doRegister() {
        this.err = ''; this.busy = true;
        try {
          await api('POST', '/auth/register', { username: this.ruser, password: this.rpass, display_name: this.rname, invite_code: this.rinvite });
          this.err = '注册成功，请登录'; this.showReg = false; this.username = this.ruser; this.password = this.rpass;
        } catch (e) { this.err = e.message; } finally { this.busy = false; }
      },
    },
  };

  // ---------- 首尾视频 ----------
  const Generate = {
    template: `
    <div>
      <div class="page-head"><h2>首尾视频</h2><div class="desc">单图 / 首尾帧图生视频，可配音替换角色语音，带任务队列与实时过程可视化</div></div>
      <div class="card" style="margin-bottom:16px">
        <div class="row" style="flex:none;align-items:center;gap:12px">
          <button class="btn primary" :disabled="busy" @click="go" style="flex:none">{{ busy ? '已加入队列…' : '开始生成' }}</button>
          <button v-if="busy" class="btn danger" @click="stopJob" style="flex:none" title="停止任务（批量=停止全部；排队中出队、执行中安全打断）">停止</button>
          <div v-if="job || statusText || batchEntries.length" style="flex:1;min-width:0">
            <div class="progress"><div :style="{ width: showPct + '%', background: barColor }"></div></div>
            <div class="muted" style="display:flex;align-items:center;gap:8px;margin-top:6px;white-space:nowrap">
              <span v-if="busy" class="spin"></span><b>{{ showPct }}%</b><span v-if="elapsedText">{{ elapsedText }}</span>
              <span v-if="batchEntries.length > 1" class="badge ok">第 {{ batchCurrentIdx }} / 共 {{ batchEntries.length }} 个</span>
              <span class="ellip" :title="batchEntries.length > 1 ? batchLine : progressText">{{ batchEntries.length > 1 ? batchLine : progressText }}</span>
            </div>
            <div v-if="job && job.error" class="alert err" style="margin-top:8px">{{ job.error }}</div>
          </div>
        </div>
      </div>
      <div class="grid-2">
        <div class="card">
          <h3>输入图像 <span class="muted" style="font-size:13px;font-weight:normal">当前模式：{{ endImage ? '首尾帧（首帧 → 尾帧）' : '单图（图生视频）' }}</span></h3>
          <div class="row" style="flex-wrap:nowrap">
            <div class="field" style="min-width:0">
              <label>首帧图像（必传）</label>
              <input type="file" accept="image/*" @change="onFile" />
              <img v-if="preview" :src="preview" class="preview-img" style="margin-top:10px;max-height:240px" />
              <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
                <button v-if="image" class="btn sm" @click="clearStart">清除首帧</button>
                <button class="btn sm" @click="openPick('first')" title="从文生图/分层图的历史生成图中选一张当首帧">从系统选图</button>
                <button class="btn sm" @click="openPaste('first')" title="粘贴剪贴板图片（Ctrl+V）作为首帧">粘贴图片</button>
              </div>
            </div>
            <div class="field" style="min-width:0">
              <label>尾帧图像（可选）</label>
              <input type="file" accept="image/*" @change="onEndFile" />
              <img v-if="endPreview" :src="endPreview" class="preview-img" style="margin-top:10px;max-height:240px" />
              <div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">
                <button v-if="endImage" class="btn sm" @click="clearEnd">清除尾帧</button>
                <button class="btn sm" @click="openPick('end')" title="从文生图/分层图的历史生成图中选一张当尾帧">从系统选图</button>
                <button class="btn sm" @click="openPaste('end')" title="粘贴剪贴板图片（Ctrl+V）作为尾帧">粘贴图片</button>
              </div>
            </div>
          </div>
          <div class="muted" style="margin-top:4px">只传首帧 = 单图生成；再传尾帧 = 自动切换首尾帧模式，清除尾帧即回到单图。</div>
          <!-- v1.0.43 从系统选图：首帧/尾帧共用（文生图+分层图最近完成的生成图）；需求28 批量槽位多选模式 -->
          <div v-if="pickOpen" class="overlay" @click.self="pickOpen = false">
            <div class="card" style="max-width:880px;width:94vw;max-height:82vh;overflow:auto">
              <h3 style="margin:0 0 10px">从系统选图（{{ pickMulti ? (pickTarget === 'batchEnd' ? '多选 → 批量尾帧' : '多选 → 批量首帧') : (pickTarget === 'end' ? '作为尾帧' : '作为首帧') }}）</h3>
              <div v-if="pickMulti" class="muted" style="font-size:12px;margin-bottom:8px">点选多张、按点选顺序排队（角标数字 = 顺序），选完点右下角确定。</div>
              <div v-if="pickBusy" style="padding:24px;text-align:center;opacity:.7">加载中…</div>
              <div v-else-if="!pickList.length" style="padding:24px;text-align:center;opacity:.7">还没有已完成的生成图</div>
              <div v-else style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
                <div v-for="it in pickList" :key="it.id" :title="pickMulti ? '点选/取消此图' : '点选此图'" style="position:relative;cursor:pointer;border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:6px;text-align:center" :style="pickMulti && pickSel.includes(it.id) ? { border: '2px solid var(--primary)', padding: '5px' } : undefined" @click="pickMulti ? togglePick(it) : pickOne(it)">
                  <img :src="it.url" style="width:100%;height:92px;object-fit:cover;border-radius:4px" />
                  <div style="font-size:12px;margin-top:4px">{{ it.src }} {{ it.wh }}<span v-if="it.mode"> · {{ it.mode }}</span></div>
                  <div style="font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ it.prompt || it.file }}</div>
                  <div v-if="pickMulti && pickSel.includes(it.id)" style="position:absolute;left:2px;top:2px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;border-radius:4px;padding:0 5px;line-height:18px">{{ pickSel.indexOf(it.id) + 1 }}</div>
                </div>
              </div>
              <div style="margin-top:12px;display:flex;gap:10px;justify-content:flex-end;align-items:center">
                <span class="muted" style="flex:1;font-size:12px">{{ pickMulti && pickSel.length ? '已选 ' + pickSel.length + ' 张（按点选顺序）' : '' }}</span>
                <button class="btn sm" @click="pickOpen = false">取消</button>
                <button v-if="pickMulti" class="btn primary" :disabled="!pickSel.length || pickBusy" @click="pickMultiOk">确定（{{ pickSel.length }} 张）</button>
              </div>
            </div>
          </div>

          <!-- 需求28 粘贴图片：首帧/尾帧/批量首帧/批量尾帧共用 -->
          <PasteDlg v-if="pasteOpen" :title="pasteTitle" :multi="pasteMulti" @confirm="onPasteConfirm" @close="pasteOpen = false" />

          <div style="border-top:1px dashed var(--border);margin-top:14px;padding-top:12px">
            <h3 style="margin:0 0 8px">批量生成 <span class="muted" style="font-size:13px;font-weight:normal">（用上方同一套提示词与参数，逐个排队生成，完成一个即在「最近视频」出现一个）</span></h3>
            <div class="row" style="flex-wrap:nowrap">
              <div class="field" style="min-width:0">
                <label>批量首帧（可多选，按选择顺序排队）</label>
                <input type="file" accept="image/*" multiple @change="onBatchFirst" />
                <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn sm" @click="openPaste('batchFirst')" title="粘贴剪贴板图片（Ctrl+V，可连续多张）">粘贴图片</button>
                  <button class="btn sm" @click="openPickMulti('batchFirst')" title="从文生图/分层图的历史生成图中多选，按点选顺序排队">从系统选图</button>
                </div>
                <div class="muted" style="margin-top:4px">{{ batchFirst.length ? '已选 ' + batchFirst.length + ' 张' : '未选择' }}</div>
              </div>
              <div class="field" style="min-width:0">
                <label>批量尾帧（可选；须与首帧数量一致、按顺序一一对应）</label>
                <input type="file" accept="image/*" multiple @change="onBatchEnd" />
                <div style="margin-top:6px;display:flex;gap:8px;flex-wrap:wrap">
                  <button class="btn sm" @click="openPaste('batchEnd')" title="粘贴剪贴板图片（Ctrl+V，可连续多张）">粘贴图片</button>
                  <button class="btn sm" @click="openPickMulti('batchEnd')" title="从文生图/分层图的历史生成图中多选，按点选顺序一一对应">从系统选图</button>
                </div>
                <div class="muted" style="margin-top:4px">{{ batchEnd.length ? '已选 ' + batchEnd.length + ' 张' : '未选择（全部按单图模式生成）' }}</div>
              </div>
            </div>
            <div v-if="batchFirst.length" style="margin-top:8px">
              <div class="muted" style="margin-bottom:4px">{{ batchEnd.length ? '配对关系（首帧 → 尾帧，按选择顺序一一对应，即排队顺序）：' : '首帧清单（单图模式，按选择顺序排队）：' }}</div>
              <div style="max-height:220px;overflow:auto;border:1px solid var(--border);border-radius:6px;padding:6px 12px">
                <div v-for="(f, i) in batchFirst" :key="i" style="display:flex;align-items:center;gap:8px;padding:2px 0">
                  <span class="muted" style="flex:none;min-width:20px;text-align:right">{{ i + 1 }}.</span>
                  <span class="ellip" style="flex:1" :title="f.name">{{ f.name }}</span>
                  <template v-if="batchEnd.length">
                    <span class="muted" style="flex:none">→</span>
                    <span class="ellip" style="flex:1" :style="batchEnd[i] ? undefined : { color: 'var(--danger)' }" :title="batchEnd[i] ? batchEnd[i].name : ''">{{ batchEnd[i] ? batchEnd[i].name : '⚠ 缺对应尾帧' }}</span>
                  </template>
                  <span v-if="batchStat(i)" class="badge" :class="batchStatCls(i)" style="flex:none">{{ batchStat(i) }}</span>
                </div>
              </div>
              <div v-if="batchEnd.length > batchFirst.length" class="muted" style="margin-top:4px;color:var(--danger)">⚠ 尾帧比首帧多 {{ batchEnd.length - batchFirst.length }} 张（多出的不参与生成）</div>
            </div>
            <div class="row" style="flex:none;align-items:center;gap:10px;margin-top:8px">
              <button class="btn primary" :disabled="batchBusy" @click="batchGo">{{ batchBusy ? '提交中…' : '批量加入队列' }}</button>
              <button class="btn" v-if="batchFirst.length || batchEnd.length" @click="clearBatch">清除所选（重新选图）</button>
              <span v-if="batchInfo" class="muted">{{ batchInfo }}</span>
            </div>
          </div>
        </div>
        <div class="card">
          <h3>提示词</h3>
          <div class="field">
            <label>动作提示词（必填）</label>
            <textarea v-model="prompt" placeholder="例如：女人放下画笔，缓缓转身…"></textarea>
          </div>
          <div class="field">
            <label>Qwen3-vl提示词（引导语 → 生成提示词）</label>
            <div class="row" style="flex-wrap:nowrap;align-items:center">
              <input v-model="guideText" placeholder="输入一段引导语，例如：诱惑 / 海边散步 / 都市夜景" />
              <button class="btn sm" style="flex:none" :disabled="qwenBusy" @click="genPrompt">{{ qwenBusy ? '生成中…' : '点击生成提示词' }}</button>
            </div>
          </div>
          <div class="field"><label>负面提示词（留空则用默认）</label><textarea v-model="negative" placeholder="留空则使用默认负面提示词"></textarea></div>
          <div class="row">
            <div class="field"><label>时长（秒）</label><input type="number" v-model.number="length" min="1" max="30" /></div>
            <div class="field"><label>视频帧率（fps）</label><input type="number" v-model.number="fps" min="1" max="60" /></div>
            <div class="field"><label>迭代次数（steps）</label><input type="number" v-model.number="steps" min="1" max="50" /></div>
          </div>
          <div class="row">
            <div class="field"><label>宽</label><input type="number" v-model.number="width" min="256" max="1280" /></div>
            <div class="field"><label>高</label><input type="number" v-model.number="height" min="256" max="1280" /></div>
            <div class="field"><label>帧插值倍数</label><select v-model.number="interp"><option :value="1">1×（不插值）</option><option :value="2">2×</option><option :value="3">3×</option><option :value="4">4×</option></select></div>
          </div>
          <div class="field"><label>种子（默认 -1 随机，可指定如 42）</label><input v-model="seed" placeholder="-1" /></div>
        </div>
      </div>

      <div class="card">
        <h3>加速 / 高清 / LoRA <button class="btn sm" :disabled="loraBusy" @click="refreshLoras" style="margin-left:10px">{{ loraBusy ? '刷新中…' : '刷新Lora列表' }}</button></h3>
        <div class="row">
          <label class="chk"><input type="checkbox" v-model="useSage" /> 是否开启 sage-attn 加速</label>
          <label class="chk"><input type="checkbox" v-model="highRes" /> 是否开启高清修复</label>
          <div class="field" v-if="highRes"><label>视频放大倍数（越大显存消耗越多）</label>
            <select v-model.number="highResScale"><option :value="2">2倍原图放大</option><option :value="3">3倍原图放大</option><option :value="4">4倍原图放大</option></select>
          </div>
        </div>
        <div class="row" style="margin-top:12px">
          <div class="field" v-for="(slot, i) in loras" :key="i">
            <label>{{ i === 0 ? '选择Lora_1(默认加速lora,不要动)' : (i === 1 ? '选择Lora_2' : 'Lora_' + (i+1)) }}</label>
            <select v-model="slot.name"><option v-for="l in loraList" :key="l" :value="l">{{ l }}</option></select>
            <label style="margin-top:6px">lora权重</label>
            <input type="number" v-model.number="slot.strength" step="0.1" min="0" />
          </div>
        </div>
      </div>

      <div class="card">
        <h3><label><input type="checkbox" v-model="useDub" /> 配音（语音克隆替换角色语音）</label></h3>
        <div v-if="useDub" class="row">
          <div class="field"><label>音色</label><select v-model="dubVoice"><option :value="v.id" v-for="v in voices" :key="v.id">{{ v.name }}</option></select></div>
          <div class="field" style="flex:2"><label>配音台词</label><input v-model="dubText" placeholder="输入角色要说的台词" /></div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>最近视频
          <button class="btn sm" style="margin-left:10px" @click="openFolder">打开文件夹</button>
          <span class="muted" style="margin-left:10px">共 {{ doneVideos.length }} 个</span>
        </h3>
        <div v-if="!doneVideos.length" class="muted">暂无已完成的视频</div>
        <div v-else class="vstrip">
          <div v-for="v in recentVideos" :key="v.id" class="vcard peek" :title="(v.prompt || '') + '\\n点击打开，← → 前后翻页'" @click="openVid(v)">
            <video :src="vidUrl(v)" preload="metadata"></video>
            <div class="vmeta">
              <span class="muted">#{{ v.id }}</span>
              <a class="btn sm" :href="vidUrl(v)" download @click.stop>下载</a>
            </div>
          </div>
        </div>
        <div v-if="doneVideos.length > 10" class="muted" style="margin-top:6px">点视频可打开查看，← → 翻看全部 {{ doneVideos.length }} 个（条内仅显示最近 10 个）</div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>任务队列详情</h3>
        <div v-if="!queue.length" class="muted">队列为空</div>
        <template v-else>
          <table class="tbl">
            <thead><tr><th>#</th><th>提示词</th><th>状态</th><th>过程</th><th>尺寸</th><th>耗时</th><th>结果</th></tr></thead>
            <tbody>
              <tr v-for="q in pagedQueue" :key="q.id">
                <td>{{ q.id }}</td>
                <td class="ellip" :title="q.prompt">{{ q.prompt || '-' }}</td>
                <td>{{ statusLabel(q.status) }}</td>
                <td class="ellip">{{ q.progress || '-' }}</td>
                <td class="muted">{{ sizeOf(q) }}</td>
                <td class="muted">{{ fmtDur(q.duration_ms) }}</td>
                <td>
                  <a v-if="q.video_path" class="btn sm" :href="authed('/api/generate/output/' + basename(q.video_path))" download>下载</a>
                  <a class="btn sm" :href="authed('/api/generate/workflow/' + q.id)">工作流</a>
                  <button class="btn sm" @click="regen(q)" title="把该任务的提示词与全部参数还原到上方（不自动生成）">再生成</button>
                  <span v-if="q.status==='failed'" style="color:var(--danger)">{{ q.error }}</span>
                  <span v-else-if="!q.video_path">-</span>
                </td>
              </tr>
            </tbody>
          </table>
          <div class="row" style="flex:none;align-items:center;justify-content:flex-end;margin-top:10px;gap:10px">
            <span class="muted">共 {{ queue.length }} 条</span>
            <label class="muted">每页
              <select v-model.number="qSize" @change="qPage=1" style="margin:0 6px">
                <option :value="5">5</option><option :value="10">10</option><option :value="30">30</option><option :value="50">50</option>
              </select>行</label>
            <button class="btn sm" :disabled="qPage<=1" @click="qPage--">‹ 上一页</button>
            <span class="muted">{{ qPage }} / {{ qPages }}</span>
            <button class="btn sm" :disabled="qPage>=qPages" @click="qPage++">下一页 ›</button>
          </div>
        </template>
      </div>
    </div>`,
    data() {
      return {
        preview: '', image: '', image_ext: 'png',
        endPreview: '', endImage: '', endImage_ext: 'png',
        pickOpen: false, pickBusy: false, pickList: [], pickTarget: 'first', pickMulti: false, pickSel: [], // v1.0.43 从系统选图（首帧/尾帧共用弹窗）；需求28 pickMulti=批量槽位多选
        pasteOpen: false, pasteTarget: 'first', pasteMulti: false, pasteTitle: '', // 需求28 粘贴图片（首帧/尾帧单张，批量首帧/尾帧多张）
        prompt: '', negative: '', guideText: '',
        length: 5, width: 368, height: 704, interp: 2, seed: -1, fps: 16, steps: 4,
        useSage: true, highRes: false, highResScale: 4,
        loras: [{ name: 'None', strength: 1 }, { name: 'None', strength: 1 }, { name: 'None', strength: 1 }, { name: 'None', strength: 1 }],
        loraList: ['None'],
        useDub: false, dubVoice: 0, dubText: '', voices: [],
        busy: false, statusText: '', job: null, timer: null, pctHigh: 0,
        queue: [], qTimer: null, qwenBusy: false, loraBusy: false,
        qPage: 1, qSize: 5,
        batchFirst: [], batchEnd: [], batchBusy: false, batchInfo: '', batchEntries: [],
      };
    },
    computed: {
      videoUrl() { return this.job && this.job.video_path ? authed('/api/generate/output/' + basename(this.job.video_path)) : ''; },
      qPages() { return Math.max(1, Math.ceil((this.queue || []).length / this.qSize)); },
      pagedQueue() { const q = this.queue || []; const s = (this.qPage - 1) * this.qSize; return q.slice(s, s + this.qSize); },
      doneVideos() {
        return (this.queue || []).filter((q) => q.status === 'done' && q.video_path);
      },
      recentVideos() { return this.doneVideos.slice(0, 10); },
      jobProgressPct() {
        if (!this.job) return 0;
        if (this.job.status === 'done' || this.job.status === 'failed') return 100;
        const p = Number(this.job.progress_pct);
        return Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
      },
      // v1.0.13：批量时进度按「全部任务」计——(已完成数 + 当前任务进度/100) / 总数；单个任务按原口径。
      // pctHigh 高水位兜底：进度条只进不退（此前采样节点 99% 后切帧插值节点会掉回 33%）
      showPct() {
        const p = (this.batchEntries || []).length > 1 ? this.batchPct : this.jobProgressPct;
        return Math.max(this.pctHigh, Number.isFinite(p) ? p : 0);
      },
      barColor() { return (this.job && this.job.status === 'failed') ? 'var(--danger)' : undefined; },
      batchJobMap() { const m = {}; for (const q of (this.queue || [])) m[String(q.id)] = q; return m; },
      batchStats() {
        const ents = (this.batchEntries || []).filter((e) => e && e.ok);
        if (!ents.length) return { total: 0, done: 0, okc: 0, cur: null };
        let done = 0, okc = 0, cur = null;
        for (const e of ents) {
          const j = this.batchJobMap[String(e.id)];
          if (!j) continue;
          if (j.status === 'done') { done++; okc++; }
          else if (j.status === 'failed') { done++; }
          else if (!cur) cur = j;
        }
        return { total: ents.length, done, okc, cur };
      },
      batchPct() {
        const s = this.batchStats;
        if (!s.total) return 0;
        if (s.done >= s.total) return 100;
        const cp = s.cur ? (Number(s.cur.progress_pct) || 0) / 100 : 0;
        return Math.min(99, Math.round(((s.done + cp) / s.total) * 100));
      },
      batchCurrentIdx() { const s = this.batchStats; return s.total ? Math.min(s.done + 1, s.total) : 0; },
      batchLine() {
        const s = this.batchStats;
        if (!s.total) return '';
        if (s.done >= s.total) return '批量完成：' + s.okc + ' 成功' + (s.total - s.okc ? '、' + (s.total - s.okc) + ' 失败' : '');
        const t = s.cur ? (s.cur.progress || (s.cur.status === 'pending' ? '排队中…' : '生成中…')) : '等待队列…';
        return '第 ' + this.batchCurrentIdx + ' 个：' + t;
      },
      progressText() {
        if (this.job && this.job.progress) return this.job.progress;
        if (this.job && this.job.status === 'failed') return '生成失败';
        return this.statusText || '准备中…';
      },
    },
    async mounted() {
      this.loadVoices();
      this.loadLoras().catch(() => {});
      this.loadDefaultNeg();
      this.refreshQueue();
      this.qTimer = setInterval(() => this.refreshQueue(), 3000);
    },
    methods: {
      authed, basename,
      statusLabel(s) { return { pending: '排队中', running: '生成中', done: '完成', failed: '失败' }[s] || s; },
      sizeOf(q) { try { const p = JSON.parse(q.params || '{}'); return p.width && p.height ? p.width + '×' + p.height : '-'; } catch { return '-'; } },
      fmtDur(ms) {
        if (!ms || ms <= 0) return '-';
        if (ms < 1000) return ms + 'ms';
        if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
        const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
        return m + 'm' + (s ? s + 's' : '');
      },
      vidUrl(q) { return authed('/api/generate/output/' + basename(q.video_path)); },
      // v1.0.15：点开大窗播放，← → 在全部已完成视频间前后翻页
      openVid(v) {
        const items = this.doneVideos.map((q) => ({ kind: 'video', url: this.vidUrl(q), title: q.prompt || '', sub: '#' + q.id + ' · ' + (q.created_at || '') }));
        openViewer(items, this.doneVideos.indexOf(v));
      },
      // 读单个图像文件为 {data, ext, name}（批量用，不生成预览但保留文件名与对应关系）
      readImgFile(f) {
        return new Promise((res) => {
          const r = new FileReader();
          r.onload = () => res({ data: r.result, ext: f.name.split('.').pop(), name: f.name });
          r.onerror = () => res(null);
          r.readAsDataURL(f);
        });
      },
      onBatchFirst(e) {
        const files = [...e.target.files]; e.target.value = '';
        Promise.all(files.map((f) => this.readImgFile(f))).then((arr) => {
          this.batchFirst = arr.filter(Boolean);
          this.syncBatchInfo();
        });
      },
      onBatchEnd(e) {
        const files = [...e.target.files]; e.target.value = '';
        Promise.all(files.map((f) => this.readImgFile(f))).then((arr) => {
          this.batchEnd = arr.filter(Boolean);
          this.syncBatchInfo();
        });
      },
      syncBatchInfo() {
        if (this.batchFirst.length && this.batchEnd.length && this.batchFirst.length !== this.batchEnd.length)
          this.batchInfo = '⚠ 首帧 ' + this.batchFirst.length + ' 张、尾帧 ' + this.batchEnd.length + ' 张，数量不一致（尾帧须与首帧按顺序一一对应）';
        else this.batchInfo = '';
      },
      async openFolder() { try { await api('POST', '/generate/open-output-dir'); } catch (e) { alert(e.message); } },
      async loadVoices() { try { const d = await api('GET', '/tts/voices'); this.voices = d.voices; this.dubVoice = d.default_voice_id; } catch (e) {} },
      async loadLoras(resetDefaults = true) {
        const d = await api('GET', '/generate/loras');
        this.loraList = d.loras;
        if (resetDefaults && d.defaults) {
          this.loras[0].name = d.defaults.lora_1 || 'None';
          this.loras[0].strength = d.defaults.strength_1 || 1;
          this.loras[1].name = d.defaults.lora_2 || 'None';
          this.loras[1].strength = d.defaults.strength_2 || 1;
        }
      },
      async refreshLoras() {
        this.loraBusy = true;
        try { await this.loadLoras(false); }
        catch (e) { alert(e.message); }
        finally { this.loraBusy = false; }
      },
      async loadDefaultNeg() { try { const d = await api('GET', '/generate/negative-default'); this.negative = d.negative || ''; } catch (e) {} },
      async refreshQueue() {
        try {
          const d = await api('GET', '/generate/queue'); this.queue = d.jobs || [];
          // 批量跟踪：全部结束才收尾（此前只盯第一个任务，第 1 个完成就显示 100%）
          if (this.busy && (this.batchEntries || []).length > 1) {
            this.pctHigh = Math.max(this.pctHigh, this.batchPct);
            if (this.batchStats.total && this.batchStats.done >= this.batchStats.total) {
              this.busy = false; this.statusText = '完成'; this.stopClock();
            }
          }
          // 切页回来：接续自己进行中的单个任务（批量模式的状态在离开页面时已丢，按单任务接续显示）
          if (!this.busy && !(this.batchEntries || []).length) {
            const run = (this.queue || []).find((q) => (q.status === 'running' || q.status === 'pending') && q.user_id === store.user.id);
            if (run) {
              this.busy = true; this.statusText = run.status === 'pending' ? '排队中…' : '生成中…';
              this.startClock(Date.parse(String(run.created_at || '').replace(' ', 'T')) || undefined);
              this.poll(run.id);
            }
          }
        } catch (e) { /* 未登录/失败忽略 */ }
      },
      onFile(e) { const f = e.target.files[0]; e.target.value = ''; if (!f) return; const r = new FileReader(); r.onload = () => { this.preview = r.result; this.image = r.result; this.image_ext = f.name.split('.').pop(); }; r.readAsDataURL(f); },
      onEndFile(e) { const f = e.target.files[0]; e.target.value = ''; if (!f) return; const r = new FileReader(); r.onload = () => { this.endPreview = r.result; this.endImage = r.result; this.endImage_ext = f.name.split('.').pop(); }; r.readAsDataURL(f); },
      clearStart() { this.preview = ''; this.image = ''; },
      clearEnd() { this.endPreview = ''; this.endImage = ''; },
      // v1.0.43 从系统选图：文生图+分层图最近完成的生成图 → 首帧/尾帧（上传功能保留不变）
      openPick(target) { this.pickTarget = target === 'end' ? 'end' : 'first'; this.pickMulti = false; this.pickSel = []; this.loadPick(); },
      // 需求28：批量槽位从系统选图（多选，按点选顺序排队）——与单选同一弹窗的另一模式
      openPickMulti(target) { this.pickTarget = target === 'batchEnd' ? 'batchEnd' : 'batchFirst'; this.pickMulti = true; this.pickSel = []; this.loadPick(); },
      togglePick(it) { const i = this.pickSel.indexOf(it.id); if (i >= 0) this.pickSel.splice(i, 1); else this.pickSel.push(it.id); },
      async pickMultiOk() {
        if (!this.pickSel.length) return;
        this.pickBusy = true;
        try {
          const out = [];
          for (const id of this.pickSel) {
            const it = this.pickList.find((x) => x.id === id); if (!it) continue;
            const r = await fetch(it.url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const blob = await r.blob();
            const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读取失败')); fr.readAsDataURL(blob); });
            out.push({ name: it.file, dataUrl, ext: (it.file.split('.').pop() || 'png'), data: dataUrl });
          }
          if (this.pickTarget === 'batchEnd') this.batchEnd = out; else this.batchFirst = out;
          this.syncBatchInfo();
          this.pickOpen = false;
        } catch (e) { alert('选图失败：' + e.message); }
        this.pickBusy = false;
      },
      // 需求28 粘贴图片：单槽（首帧/尾帧）取最后一张；批量槽位整组按粘贴顺序入列
      openPaste(target) {
        this.pasteTarget = target;
        this.pasteMulti = (target === 'batchFirst' || target === 'batchEnd');
        this.pasteTitle = { first: '粘贴图片（作为首帧）', end: '粘贴图片（作为尾帧）', batchFirst: '粘贴图片（批量首帧，可多张）', batchEnd: '粘贴图片（批量尾帧，可多张）' }[target] || '粘贴图片';
        this.pasteOpen = true;
      },
      onPasteConfirm(list) {
        this.pasteOpen = false;
        if (!list || !list.length) return;
        if (this.pasteTarget === 'end') { const it = list[list.length - 1]; this.endPreview = it.dataUrl; this.endImage = it.dataUrl; this.endImage_ext = it.ext; }
        else if (this.pasteTarget === 'batchFirst') { this.batchFirst = list; this.syncBatchInfo(); }
        else if (this.pasteTarget === 'batchEnd') { this.batchEnd = list; this.syncBatchInfo(); }
        else { const it = list[list.length - 1]; this.preview = it.dataUrl; this.image = it.dataUrl; this.image_ext = it.ext; }
      },
      async loadPick() {
        this.pickOpen = true; this.pickBusy = true;
        try {
          const d = await api('GET', '/image/queue');
          this.pickList = (d.jobs || []).filter((j) => j.status === 'done' && j.image_path).map((j) => {
            let wh = '', mode = '';
            try {
              const pp = JSON.parse(j.params || '{}');
              if (pp.width && pp.height) wh = pp.width + '×' + pp.height;
              if (pp.gen_mode === 'hires') mode = '重绘'; else if (pp.gen_mode === 'upscale') mode = '超分';
            } catch (e) { /* 参数解析失败照样可选 */ }
            const file = basename(j.image_path);
            return { id: j.id, file, wh, mode, src: { ad: '分层图', h3: '文生图H3' }[j.source] || '文生图Z', url: authed('/api/image/output/' + file), prompt: String(j.prompt || '').slice(0, 40) };
          });
        } catch (e) { alert('拉取历史图失败：' + e.message); this.pickOpen = false; }
        this.pickBusy = false;
      },
      async pickOne(it) {
        this.pickBusy = true;
        try {
          const r = await fetch(it.url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const blob = await r.blob();
          const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读取失败')); fr.readAsDataURL(blob); });
          if (this.pickTarget === 'end') { this.endPreview = dataUrl; this.endImage = dataUrl; this.endImage_ext = (it.file.split('.').pop() || 'png'); }
          else { this.preview = dataUrl; this.image = dataUrl; this.image_ext = (it.file.split('.').pop() || 'png'); }
          this.pickOpen = false;
        } catch (e) { alert('选图失败：' + e.message); }
        this.pickBusy = false;
      },
      async genPrompt() {
        if (!this.guideText.trim()) { alert('请先输入引导语（主题）'); return; }
        this.qwenBusy = true;
        try {
          const d = await api('POST', '/generate/qwen', { text: this.guideText });
          this.prompt = d.prompt || this.prompt;
        } catch (e) { alert(e.message); } finally { this.qwenBusy = false; }
      },
      // 由当前表单提示词/参数 + 指定首尾帧构造 /generate 请求体（单个与批量共用同一套）
      genBody(img, endImg) {
        const dub = this.useDub ? { voice_id: this.dubVoice, text: this.dubText } : null;
        return {
          image: img.data, image_ext: img.ext,
          end_image: endImg ? endImg.data : undefined, end_image_ext: endImg ? endImg.ext : undefined,
          prompt: this.prompt, negative_prompt: this.negative, seed: this.seed,
          length: this.length, width: this.width, height: this.height, fps: this.fps, steps: this.steps, interpolation: this.interp,
          mode: endImg ? 'flf' : 'single', // 尾帧传了就是首尾帧模式，没传就是单图
          sage_attention: this.useSage ? 'auto' : 'disabled',
          high_res: this.highRes, high_res_scale: this.highResScale, dub,
          loras: this.loras.map((l) => ({ name: l.name || 'None', strength: l.strength })),
        };
      },
      async go() {
        if (!this.image) { alert('请先上传首帧图像'); return; }
        if (!this.prompt.trim()) { alert('请输入提示词'); return; }
        this.busy = true; this.job = null; this.statusText = '提交中…'; this.pctHigh = 0; this.batchEntries = []; this.startClock();
        try {
          const _busy = await busyBefore();
          const d = await api('POST', '/generate', this.genBody(
            { data: this.image, ext: this.image_ext },
            this.endImage ? { data: this.endImage, ext: this.endImage_ext } : null
          ));
          this.poll(d.id);
          this.refreshQueue();
          queueBusyNotice(_busy);
        } catch (e) { alert(e.message); this.statusText = ''; this.busy = false; this.stopClock(); }
      },
      // 批量：N 张首帧（+ 可选 N 张按顺序对应的尾帧）→ N 个任务进后端串行队列。
      // v1.0.13：全部任务逐个登记（含提交失败的），进度/文字按「全部任务」口径计算，
      // 跟踪到全部结束——进度条占比 = 总任务数，不再只盯第一个任务。
      async batchGo() {
        if (!this.batchFirst.length) { alert('请先批量选择首帧图像'); return; }
        if (!this.prompt.trim()) { alert('请输入提示词（批量任务共用同一套提示词与参数）'); return; }
        const useFlf = this.batchEnd.length > 0;
        if (useFlf && this.batchEnd.length !== this.batchFirst.length) {
          alert('尾帧数量（' + this.batchEnd.length + '）须与首帧（' + this.batchFirst.length + '）一致，且按选择顺序一一对应');
          return;
        }
        if (!confirm('将按选择顺序加入 ' + this.batchFirst.length + ' 个' + (useFlf ? '首尾帧' : '单图')
          + '生成任务（同一套提示词与参数，后端队列逐个生成）。继续？')) return;
        this.batchBusy = true; this.batchInfo = '';
        const entries = [];
        let fail = 0, lastErr = '';
        const _busy = await busyBefore();
        try {
          for (let i = 0; i < this.batchFirst.length; i++) {
            const body = this.genBody(this.batchFirst[i], useFlf ? this.batchEnd[i] : null);
            let okOne = false, id = 0;
            try { const d = await api('POST', '/generate', body); id = d.id; okOne = true; }
            catch (e) { fail++; lastErr = e.message; }
            entries.push({ ok: okOne, id });
          }
        } finally { this.batchBusy = false; }
        const okN = entries.filter((e) => e.ok).length;
        if (fail && !okN) { alert('批量提交全部失败：' + lastErr); return; }
        if (fail) alert('有 ' + fail + ' 个任务提交失败：' + lastErr + '（其余 ' + okN + ' 个已入队）');
        this.batchEntries = entries;
        this.batchInfo = '已加入 ' + okN + ' 个任务' + (fail ? '，失败 ' + fail + ' 个' : '') + '，按顺序逐个生成（进度按全部任务计）';
        this.busy = true; this.job = null; this.statusText = '排队中…'; this.pctHigh = 0;
        this.startClock();
        this.refreshQueue();
        queueBusyNotice(_busy);
      },
      clearBatch() { this.batchFirst = []; this.batchEnd = []; this.batchEntries = []; this.batchInfo = ''; },
      async regen(q) {
        // v1.0.38 再生成：提示词/负向/全部节点参数还原到上方，首尾帧从服务器取回（不自动提交）
        let pp = {};
        try { pp = JSON.parse(q.params || '{}'); } catch (e) { pp = {}; }
        this.prompt = String(q.prompt || '');
        this.negative = String(q.negative_prompt || '');
        this.length = pp.length ?? this.length; this.width = pp.width ?? this.width; this.height = pp.height ?? this.height;
        this.fps = pp.fps ?? this.fps; this.steps = pp.steps ?? this.steps; this.interp = pp.interpolation ?? this.interp; this.seed = pp.seed ?? this.seed;
        this.useSage = pp.sage_attention !== 'disabled'; this.highRes = !!pp.high_res; this.highResScale = pp.high_res_scale || 4;
        if (Array.isArray(pp.loras) && pp.loras.length) {
          const l = pp.loras.map((x) => ({ name: x.name || 'None', strength: Number(x.strength) || 1 }));
          while (l.length < 4) l.push({ name: 'None', strength: 1 });
          this.loras = l.slice(0, 6);
        }
        if (q.dub_text) { this.useDub = true; this.dubText = String(q.dub_text); } else { this.useDub = false; }
        const grab = async (rel) => {
          const r = await fetch(authed('/api/generate/upload/' + basename(rel)));
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const blob = await r.blob();
          return await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读取失败')); fr.readAsDataURL(blob); });
        };
        let note = '';
        try {
          if (q.image_path) {
            this.image = await grab(q.image_path); this.preview = this.image;
            this.image_ext = basename(q.image_path).split('.').pop() || 'png';
          } else note = '（原任务无首帧记录，请重新上传）';
          if (q.mode === 'flf' && q.end_image_path) {
            this.endImage = await grab(q.end_image_path); this.endPreview = this.endImage;
            this.endImage_ext = basename(q.end_image_path).split('.').pop() || 'png';
          } else { this.endImage = ''; this.endPreview = ''; }
        } catch (e) { note = '（首尾帧取回失败：' + e.message + '，请重新上传）'; }
        this.statusText = '已还原任务 #' + q.id + ' 的参数，确认后点「开始生成」' + note;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
      batchStat(i) {
        const e = (this.batchEntries || [])[i];
        if (!e) return '';
        if (!e.ok) return '提交失败';
        const j = this.batchJobMap[String(e.id)];
        if (!j) return '已入队';
        return this.statusLabel(j.status);
      },
      batchStatCls(i) {
        const s = this.batchStat(i);
        return s === '完成' ? 'ok' : (s === '失败' || s === '提交失败') ? 'err' : '';
      },
      // v1.0.14 第13条：页头停止按钮。批量=全部停（逐个走任务中心安全停止）；单个=停当前任务
      async stopJob() {
        const ids = (this.batchEntries || []).filter((e) => e.ok).map((e) => e.id);
        if (ids.length > 1) {
          if (!confirm('停止全部 ' + ids.length + ' 个批量任务？（排队中的直接出队，执行中的安全打断）')) return;
          for (const id of ids) { try { await api('POST', '/tasks/i2v/' + id + '/stop'); } catch (e) { /* 单个失败继续停其余 */ } }
          this.statusText = '停止中…';
        } else {
          const id = ids[0] || (this.job && this.job.id);
          if (!id) { alert('任务刚提交、还没登记好，1-2 秒后再点停止'); return; }
          try { await api('POST', '/tasks/i2v/' + id + '/stop'); this.statusText = '停止中…'; }
          catch (e) { alert(e.message); }
        }
      },
      poll(id) {
        this.timer = setInterval(async () => {
          try {
            const d = await api('GET', '/generate/job/' + id);
            this.job = d.job;
            const p = Number(d.job.progress_pct);
            if (Number.isFinite(p)) this.pctHigh = Math.max(this.pctHigh, Math.min(100, p));
            if (d.job.status === 'done') { this.statusText = '完成'; this.busy = false; this.stopClock(); clearInterval(this.timer); }
            else if (d.job.status === 'failed') { this.statusText = '失败'; this.busy = false; this.stopClock(); clearInterval(this.timer); }
            else this.statusText = d.job.progress || (d.job.status === 'pending' ? '排队中…' : '生成中…');
          } catch (e) { clearInterval(this.timer); this.busy = false; this.stopClock(); this.statusText = ''; }
        }, 3000);
      },
    },
    beforeUnmount() { if (this.timer) clearInterval(this.timer); if (this.qTimer) clearInterval(this.qTimer); },
  };

  // ---------- 文生图（Z-image） ----------
  const ZImage = {
    template: `
    <div>
      <div class="page-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
        <div style="min-width:0"><h2>文生图Z</h2><div class="desc">Z-Image 文生图Lumina2 CLIP + Flux AE + Z-Image Turbo UNet</div></div>
        <div style="flex:none;display:flex;align-items:center;gap:12px">
          <div v-if="job || statusText" style="width:320px;max-width:38vw">
            <div class="progress"><div :style="{ width: showPct + '%', background: (job && job.status === 'failed') ? 'var(--danger)' : undefined }"></div></div>
            <div class="muted" style="display:flex;align-items:center;gap:8px;margin-top:4px;white-space:nowrap;font-size:12px">
              <span v-if="busy" class="spin"></span><b>{{ showPct }}%</b><span v-if="elapsedText">{{ elapsedText }}</span><span class="ellip" :title="progressText">{{ progressText }}</span>
            </div>
          </div>
          <button class="btn primary" :disabled="busy" @click="go">{{ busy ? '生成中' : '开始生成' }}</button>
          <button class="btn" :disabled="busy || batchBusy" @click="openBatch" title="粘贴多段提示词（每段以「## 图1」标题行分隔），一键批量提交多个任务排队执行">批量生成</button>
          <button v-if="busy" class="btn danger" @click="stopJob" title="停止当前任务（排队中的直接出队，执行中的安全打断）">停止</button>
        </div>
      </div>
      <div v-if="job && job.error" class="alert err" style="margin-bottom:12px">{{ job.error }}</div>

      <div class="card">
        <h3 style="margin:0 0 12px">功能控制框</h3>
        <div class="grid-2">
          <div class="field"><label>正向提示词（必填）</label><textarea v-model="p.prompt" style="min-height:140px"></textarea></div>
          <div class="field"><label>负向提示词</label>
            <div style="display:flex;gap:6px;margin-bottom:6px">
              <button class="btn sm" type="button" @click="addNeg('person')" title="追加人物负面词（防双人体/畸形手/水印等）">人物负面词</button>
              <button class="btn sm" type="button" @click="addNeg('ad')" title="追加分层图负面词（防水印/扭曲/杂乱等）">分层图负面词</button>
              <button class="btn sm" type="button" @click="clearNeg" title="清空负向提示词">清空</button>
            </div>
            <textarea v-model="p.negative" style="min-height:140px"></textarea></div>
        </div>
        <div class="row">
          <div class="field"><label>CLIP 模型（clip_name）</label><input v-model="p.clip_name" /></div>
          <div class="field"><label>CLIP 类型（type）</label>
            <select v-model="p.clip_type"><option>lumina2</option><option>sd3</option><option>flux</option><option>sdxl</option><option>stable_cascade</option></select>
          </div>
          <div class="field"><label>CLIP 设备（device）</label>
            <select v-model="p.clip_device"><option>default</option><option>cpu</option></select>
          </div>
        </div>
        <div class="row">
          <div class="field"><label>VAE 名称（vae_name）</label><input v-model="p.vae_name" /></div>
          <div class="field"><label>UNet 名称（unet_name）</label><input v-model="p.unet_name" /></div>
          <div class="field"><label>UNet 数据类型（weight_dtype）</label>
            <select v-model="p.weight_dtype"><option>default</option><option>fp8_e4m3fn</option><option>fp8_e5m2</option><option>fp16</option><option>bf16</option><option>fp32</option></select>
          </div>
        </div>
        <div class="row">
          <div class="field"><label>图像宽度（width）</label><input type="number" v-model.number="p.width" min="64" /></div>
          <div class="field"><label>图像高度（height）</label><input type="number" v-model.number="p.height" min="64" /></div>
          <div class="field" style="min-width:0;flex:none;display:flex;align-items:flex-end;padding-bottom:4px">
            <button class="btn sm" @click="swapSize" title="宽高互换（横竖版切换）">⇄ 互换</button>
          </div>
          <div class="field" style="min-width:0;flex:none;display:flex;align-items:flex-end;padding-bottom:4px">
            <label class="chk" style="display:flex;align-items:center;gap:6px;white-space:nowrap">尺寸
              <select v-model="sizePreset" @change="applyPreset">
                <option value="">常用尺寸</option>
                <option v-for="s in sizePresets" :key="s.v" :value="s.v">{{ s.label }}</option>
              </select>
            </label>
          </div>
          <div class="field" style="min-width:0;flex:none;display:flex;align-items:flex-end;padding-bottom:4px">
            <label class="chk" style="display:flex;align-items:center;gap:6px;white-space:nowrap">锁定比例
              <select v-model="ratioLock" @change="onRatioLock">
                <option value="">不锁定</option>
                <option value="16:9">16:9</option>
                <option value="4:3">4:3</option>
              </select>
            </label>
          </div>
          <div class="field"><label>批量大小（batch_size）</label><input type="number" v-model.number="p.batch_size" min="1" max="8" /></div>
          <div class="field"><label>采样移位（shift）</label><input type="number" v-model.number="p.shift" step="0.01" /></div>
        </div>
        <div class="row">
          <div class="field"><label>种子（-1 随机）</label><input v-model="p.seed" /></div>
          <div class="field"><label>生成控制（control_after_generate）</label>
            <select v-model="p.control_after_generate"><option>randomize</option><option>fixed</option><option>increment</option><option>decrement</option></select>
          </div>
          <div class="field"><label>步数（steps）</label><input type="number" v-model.number="p.steps" min="1" /></div>
          <div class="field"><label>CFG</label><input type="number" v-model.number="p.cfg" step="0.1" /></div>
        </div>
        <div class="row">
          <div class="field"><label>采样器（sampler_name）</label><input v-model="p.sampler_name" /></div>
          <div class="field"><label>调度器（scheduler）</label><input v-model="p.scheduler" /></div>
          <div class="field"><label>降噪（denoise{{ p.gen_mode === 'hires' ? '，重绘建议 0.15~0.25' : '' }}）</label><input type="number" v-model.number="p.denoise" step="0.01" min="0" max="1" /></div>
        </div>
        <div class="row">
          <div class="field"><label>重绘放大</label>
            <select v-model="p.gen_mode" @change="onGenMode">
              <option value="t2i">文生图（默认）</option>
              <option value="hires">重绘放大（img2img：低 denoise 只补细节不改画面）</option>
              <option value="upscale">纯超分放大（RealESRGAN 模型，不重绘、秒级）</option>
            </select>
          </div>
          <template v-if="p.gen_mode !== 't2i'">
            <div class="field" style="min-width:0;flex:none;display:flex;align-items:center;gap:8px;padding-bottom:4px;flex-wrap:wrap">
              <button class="btn sm" @click="$refs.hiresFile.click()">选择原图</button>
              <input ref="hiresFile" type="file" accept="image/*" style="display:none" @change="onHiresFile" />
              <button class="btn sm" @click="loadPick">从系统选图</button>
              <button class="btn sm" @click="openPaste" title="粘贴剪贴板图片（Ctrl+V）作为原图">粘贴图片</button>
              <img v-if="hiresPreview" :src="hiresPreview" style="height:38px;border-radius:4px" :title="hiresName" />
              <span v-else style="font-size:12px;opacity:.7">未选择原图</span>
            </div>
            <div class="field" v-if="p.gen_mode === 'hires'"><label>重绘前放大方式</label>
              <select v-model="p.upscale_method">
                <option value="nearest-exact">最近邻（nearest-exact）</option>
                <option value="bicubic">双三次（bicubic）</option>
                <option value="bilinear">双线性（bilinear）</option>
              </select>
            </div>
          </template>
        </div>
        <div v-if="pickOpen" class="overlay" @click.self="pickOpen = false">
          <div class="card" style="max-width:880px;width:94vw;max-height:82vh;overflow:auto">
            <h3 style="margin:0 0 10px">从系统选图（最近完成的生成图）</h3>
            <div v-if="pickBusy" style="padding:24px;text-align:center;opacity:.7">加载中…</div>
            <div v-else-if="!pickList.length" style="padding:24px;text-align:center;opacity:.7">还没有已完成的生成图</div>
            <div v-else style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
              <div v-for="it in pickList" :key="it.id" title="点选此图" style="cursor:pointer;border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:6px;text-align:center" @click="pickOne(it)">
                <img :src="it.url" style="width:100%;height:92px;object-fit:cover;border-radius:4px" />
                <div style="font-size:12px;margin-top:4px">{{ it.src }} {{ it.wh }}<span v-if="it.mode"> · {{ it.mode }}</span></div>
                <div style="font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ it.prompt || it.file }}</div>
              </div>
            </div>
            <div style="margin-top:12px;text-align:right"><button class="btn sm" @click="pickOpen = false">取消</button></div>
          </div>
        </div>
        <!-- 需求28 粘贴图片：重绘/超分原图（单槽，新粘覆盖） -->
        <PasteDlg v-if="pasteOpen" title="粘贴图片（作为重绘/超分原图）" :multi="false" @confirm="onPasteConfirm" @close="pasteOpen = false" />

        <!-- v1.0.39 批量生成：粘贴「## 图N」分段提示词，一键提交多个文生图任务 -->
        <div v-if="batchOpen" class="overlay" @click.self="closeBatch">
          <div class="card" style="max-width:860px;width:94vw;max-height:86vh;overflow:auto">
            <h3 style="margin:0 0 10px">批量生成（文生图）</h3>
            <div class="muted" style="margin-bottom:8px;font-size:12px">粘贴多段提示词，每段前面加一行以分割关键词开头的标题（默认「## 图1」「## 图2」…）。每段提交为一个独立任务，共用当前参数区的尺寸 / 采样等设置，按顺序自动排队执行。</div>
            <div class="row" style="align-items:center;margin-bottom:8px;flex-wrap:wrap">
              <label style="flex:none;font-size:13px;font-weight:600">分割关键词</label>
              <input v-model="batchSep" style="width:170px" placeholder="## 图" title="以该关键词开头的行视为一段的标题行" />
              <span class="muted" style="flex:1;min-width:220px;font-size:12px">以该关键词开头的行 = 新一段的开始；留空用默认「## 图」</span>
            </div>
            <textarea v-model="batchText" style="width:100%;min-height:300px;font-size:13px" placeholder="## 图1&#10;1、场景环境：…&#10;2、人物姿态：…&#10;&#10;## 图2&#10;1、场景环境：…"></textarea>
            <div v-if="batchText.trim()" class="row" style="align-items:center;margin-top:8px;flex-wrap:wrap">
              <b style="flex:none">解析出 {{ batchList.length }} 个任务</b>
              <span v-if="!batchList.length" class="alert err" style="margin:0;flex:1">没识别到分段：每段提示词前需要一行以分割关键词开头的标题行（当前「{{ batchSep || '## 图' }}」）</span>
              <span v-else class="muted ellip" style="flex:1;font-size:12px" :title="batchList.map(t=>t.title).join(' / ')">{{ batchList.map(t=>t.title).join(' / ') }}</span>
            </div>
            <div style="margin-top:12px;text-align:right">
              <button class="btn sm" :disabled="batchBusy" @click="closeBatch">取消</button>
              <button class="btn sm primary" style="margin-left:8px" :disabled="batchBusy || !batchList.length" @click="submitBatch">{{ batchBusy ? '提交中 ' + batchDone + '/' + batchList.length + '…' : '一键提交 ' + batchList.length + ' 个任务' }}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>最近生成图
          <button class="btn sm" style="margin-left:10px" @click="openFolder">打开文件夹</button>
          <span class="muted" style="margin-left:10px">共 {{ doneImages.length }} 张</span>
          <button class="btn sm" style="margin-left:10px" :disabled="stripPage<=0" @click="stripPage--">‹</button>
          <button class="btn sm" :disabled="(stripPage+1)*stripSize>=doneImages.length" @click="stripPage++">›</button>
        </h3>
        <div v-if="!doneImages.length" class="muted">暂无已完成的图片</div>
        <div v-else class="img-strip">
          <div v-for="im in stripSlice" :key="im.id" class="img-strip-card" :title="im.prompt || ''">
            <img :src="imgUrl(im)" style="cursor:zoom-in" @click="zoomImg(im)" />
            <div class="vmeta"><span class="muted">#{{ im.id }}</span><a class="btn sm" :href="imgUrl(im)" download>下载</a></div>
          </div>
        </div>
        <div v-if="doneImages.length > stripSize" class="muted" style="margin-top:6px">点图片可放大，放大后 ← → 翻看全部 {{ doneImages.length }} 张</div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>任务队列详情</h3>
        <div v-if="!queue.length" class="muted">队列为空</div>
        <table v-else class="tbl">
          <thead><tr><th>序号</th><th>提示词</th><th>尺寸</th><th>状态</th><th>过程</th><th>耗时</th><th>使用模型</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="q in queuePage" :key="q.id">
              <td>{{ q.id }}</td>
              <td class="ellip" :title="q.prompt">{{ q.prompt || '-' }}</td>
              <td>{{ sizeOf(q) }}</td>
              <td>{{ statusLabel(q.status) }}</td>
              <td class="ellip">{{ q.progress || '-' }}</td>
              <td class="muted">{{ fmtDur(q.duration_ms) }}</td>
              <td class="ellip" :title="modelOf(q)">{{ modelOf(q) }}</td>
              <td style="white-space:nowrap">
                <button class="btn sm" @click="regen(q)" title="把该任务的参数还原到上方参数框（不自动生成）">再生成</button>
                <a v-if="q.image_path" class="btn sm" :href="authed('/api/image/output/' + basename(q.image_path))" download>下载</a>
                <a class="btn sm" :href="authed('/api/image/workflow/' + q.id)">工作流</a>
                <span v-if="q.status==='failed'" style="color:var(--danger)">{{ q.error }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="queue.length > qPageSize || qPage > 0" class="row" style="flex:none;justify-content:flex-end;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">
          <span class="muted">共 {{ queue.length }} 条</span>
          <select v-model.number="qPageSize" @change="qPage = 0" style="width:auto">
            <option>10</option><option>20</option><option>30</option><option>50</option><option>100</option>
          </select>
          <span class="muted">条/页</span>
          <button class="btn sm" :disabled="qPage <= 0" @click="qPage--">‹ 上一页</button>
          <span class="muted">{{ qPage + 1 }} / {{ qTotalPages }}</span>
          <button class="btn sm" :disabled="(qPage + 1) * qPageSize >= queue.length" @click="qPage++">下一页 ›</button>
        </div>
      </div>
    </div>`,
    data() {
      return {
        p: { prompt: '', negative: '', clip_name: '', clip_type: 'lumina2', clip_device: 'default', vae_name: '', unet_name: '', weight_dtype: 'default', width: 2560, height: 1440, batch_size: 1, shift: 3.0, seed: -1, control_after_generate: 'randomize', steps: 9, cfg: 1.0, sampler_name: 'res_multistep', scheduler: 'simple', denoise: 1.0, gen_mode: 't2i', upscale_method: 'nearest-exact' },
        hiresImage: '', hiresExt: 'png', hiresPreview: '', hiresName: '', // 重绘放大原图（文件大，不进 params）
        pasteOpen: false, // 需求28 粘贴图片（重绘/超分原图）
        pickOpen: false, pickBusy: false, pickList: [], // 从系统选图（文生图/广告图最近完成产物）
        batchOpen: false, batchText: '', batchBusy: false, batchDone: 0, batchSep: '## 图', // v1.0.39 批量生成：粘贴「## 图N」分段提示词一键提交多任务；v1.0.40 分割关键词可改（默认 ## 图）
        ratioLock: '', ratio: 0, _syncing: false, sizePreset: '2560x1440', sizePresets: SIZE_PRESETS, // ''=不锁定；'16:9'/'4:3'=预设锁定（ratio=宽/高）
        busy: false, statusText: '', job: null, timer: null,
        queue: [], qTimer: null, stripPage: 0, stripSize: 10, qPage: 0, qPageSize: 10,
        pctHigh: 0,
      };
    },
    computed: {
      doneImages() { return (this.queue || []).filter((q) => q.status === 'done' && q.image_path); },
      stripSlice() { const s = this.stripPage * this.stripSize; return this.doneImages.slice(s, s + this.stripSize); },
      qTotalPages() { return Math.max(1, Math.ceil((this.queue || []).length / this.qPageSize)); },
      queuePage() { return (this.queue || []).slice(this.qPage * this.qPageSize, (this.qPage + 1) * this.qPageSize); },
      // v1.0.39 批量生成解析；v1.0.40 分割关键词可改：以 batchSep 开头的行 = 标题行（默认「## 图」，即「## 图1」这类行）
      batchList() {
        const sep = String(this.batchSep || '').trim() || '## 图';
        const lines = String(this.batchText || '').split(/\r?\n/);
        const out = []; let cur = null;
        for (const ln of lines) {
          if (ln.trim().startsWith(sep.trim())) {
            if (cur) out.push(cur);
            cur = { title: ln.trim().replace(/^#{1,6}\s+/, '').trim() || ('任务' + (out.length + 1)), text: '' };
          } else if (cur) cur.text += (cur.text ? '\n' : '') + ln;
        }
        if (cur) out.push(cur);
        return out.filter((t) => { t.text = t.text.trim(); return t.text; });
      },
      jobProgressPct() {
        if (!this.job) return 0;
        if (this.job.status === 'done' || this.job.status === 'failed') return 100;
        const p = Number(this.job.progress_pct);
        return Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
      },
      // v1.0.13：进度条只进不退（后端 pct 已按整条工作流加权，这里再兜一层防抖）
      showPct() { return Math.max(this.pctHigh, this.jobProgressPct); },
      progressText() {
        if (this.job && this.job.progress) return this.job.progress;
        if (this.job && this.job.status === 'failed') return '生成失败';
        return this.statusText || '准备中…';
      },
    },
    watch: {
      // 锁定比例：输入宽或高任意一个，另一个空的自动按锁定比例算出；清空不联动（等重新输入）。
      // 必须 flush:'sync'：Vue3 watcher 默认异步批量触发，_syncing 守卫在高度 watcher 真正执行前
      // 就已复位 → 高度反算宽度形成回声环，输入的值被改掉（实测输 1 显 2、输 1920 显 2830）
      'p.width': { flush: 'sync', handler(v) { if (this._syncing) return; this.sizePreset = ''; /* 手动输入即脱离尺寸预设 */ if (this.ratioLock && this.ratio && Number(v) > 0) { this._syncing = true; this.p.height = Math.round(Number(v) / this.ratio); this._syncing = false; } } },
      'p.height': { flush: 'sync', handler(v) { if (this._syncing) return; this.sizePreset = ''; if (this.ratioLock && this.ratio && Number(v) > 0) { this._syncing = true; this.p.width = Math.round(Number(v) * this.ratio); this._syncing = false; } } },
    },
    async mounted() {
      this.loadDefaults();
      this.refreshQueue();
      this.qTimer = setInterval(() => this.refreshQueue(), 3000);
    },
    methods: {
      authed, basename,
      sizeOf(q) { try { const p = JSON.parse(q.params || '{}'); return p.width && p.height ? p.width + '×' + p.height : '-'; } catch { return '-'; } },
      onRatioLock() {
        // 选定比例后立即生效：以已输入的一边为准算出另一边（两边都有值时以宽为准）
        this.ratio = this.ratioLock === '16:9' ? 16 / 9 : this.ratioLock === '4:3' ? 4 / 3 : 0;
        if (!this.ratio) return;
        if (Number(this.p.width) > 0) { this._syncing = true; this.p.height = Math.round(this.p.width / this.ratio); this._syncing = false; }
        else if (Number(this.p.height) > 0) { this._syncing = true; this.p.width = Math.round(this.p.height * this.ratio); this._syncing = false; }
      },
      swapSize() {
        // 宽高互换（横竖版切换）：互换后按新比例重新识别锁定预设（9:16/3:4 不在预设内→不锁定）
        const w = Number(this.p.width) || 0, h = Number(this.p.height) || 0;
        if (!w || !h) return;
        this._syncing = true; this.p.width = h; this.p.height = w; this._syncing = false;
        const r = h / w;
        this.ratioLock = Math.abs(r - 16 / 9) < 0.02 ? '16:9' : Math.abs(r - 4 / 3) < 0.02 ? '4:3' : '';
        this.ratio = this.ratioLock === '16:9' ? 16 / 9 : this.ratioLock === '4:3' ? 4 / 3 : 0;
        this.sizePreset = matchPreset(this.p.width, this.p.height);
      },
      applyPreset() {
        // v1.0.35 尺寸下拉：选中即写入宽高并重识别锁定（16:10、21:9 不在锁定预设内→不锁定）
        if (!this.sizePreset) return;
        const [w, h] = this.sizePreset.split('x').map(Number);
        this._syncing = true; this.p.width = w; this.p.height = h; this._syncing = false;
        const r = w / h;
        this.ratioLock = Math.abs(r - 16 / 9) < 0.02 ? '16:9' : Math.abs(r - 4 / 3) < 0.02 ? '4:3' : '';
        this.ratio = this.ratioLock === '16:9' ? 16 / 9 : this.ratioLock === '4:3' ? 4 / 3 : 0;
      },
      regen(q) {
        // 再生成：把该任务落库的参数整体还原进上方参数框，等用户自己点「开始生成」（不自动提交）
        let pp = {};
        try { pp = JSON.parse(q.params || '{}'); } catch (e) { alert('该任务参数无法解析'); return; }
        this._syncing = true; // 整体写回：不让宽高互锁中途重算
        for (const k of Object.keys(this.p)) if (pp[k] !== undefined) this.p[k] = pp[k];
        this._syncing = false;
        this.p.prompt = String(q.prompt || '');         // v1.0.38 报障修复：提示词/负向在独立列不在 params，此前漏还原
        this.p.negative = String(q.negative_prompt || '');
        const w = Number(this.p.width) || 0, h = Number(this.p.height) || 0;
        if (w > 0 && h > 0) {
          const r = w / h;
          this.ratioLock = Math.abs(r - 16 / 9) < 0.02 ? '16:9' : Math.abs(r - 4 / 3) < 0.02 ? '4:3' : '';
          this.ratio = this.ratioLock === '16:9' ? 16 / 9 : this.ratioLock === '4:3' ? 4 / 3 : 0;
        }
        this.sizePreset = matchPreset(w, h); // 恰好等于某预设时下拉同步选中
        this.statusText = '已还原任务 #' + q.id + ' 的参数，确认后点「开始生成」' + (this.p.gen_mode && this.p.gen_mode !== 't2i' ? '（放大模式需重新选择原图）' : '');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
      async loadDefaults() {
        try {
          const d = await api('GET', '/image/defaults');
          if (d.prompt) this.p.prompt = d.prompt;
          if (d.negative) this.p.negative = d.negative;
          if (d.clip_name) this.p.clip_name = d.clip_name;
          if (d.clip_type) this.p.clip_type = d.clip_type;
          if (d.clip_device) this.p.clip_device = d.clip_device;
          if (d.vae_name) this.p.vae_name = d.vae_name;
          if (d.unet_name) this.p.unet_name = d.unet_name;
          if (d.weight_dtype) this.p.weight_dtype = d.weight_dtype;
          if (d.width) this.p.width = d.width;
          if (d.height) this.p.height = d.height;
          if (d.batch_size) this.p.batch_size = d.batch_size;
          if (d.shift !== undefined) this.p.shift = d.shift;
          if (d.seed !== undefined) this.p.seed = d.seed;
          if (d.steps) this.p.steps = d.steps;
          if (d.cfg !== undefined) this.p.cfg = d.cfg;
          if (d.sampler_name) this.p.sampler_name = d.sampler_name;
          if (d.scheduler) this.p.scheduler = d.scheduler;
          if (d.denoise !== undefined) this.p.denoise = d.denoise;
          // 默认尺寸恰好是 16:9 / 4:3 时自动选中对应锁定，否则不锁定
          if (this.p.width && this.p.height) {
            const r = this.p.width / this.p.height;
            this.ratioLock = Math.abs(r - 16 / 9) < 0.02 ? '16:9' : Math.abs(r - 4 / 3) < 0.02 ? '4:3' : '';
            this.onRatioLock();
            this.sizePreset = matchPreset(this.p.width, this.p.height);
          }
        } catch (e) { /* 后端不可达时保留默认值 */ }
      },
      statusLabel(s) { return { pending: '排队中', running: '生成中', done: '完成', failed: '失败' }[s] || s; },
      fmtDur(ms) {
        if (!ms || ms <= 0) return '-';
        if (ms < 1000) return ms + 'ms';
        if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
        const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
        return m + 'm' + (s ? s + 's' : '');
      },
      imgUrl(q) { return authed('/api/image/output/' + basename(q.image_path)); },
      modelOf(q) {
        try { const pr = JSON.parse(q.params || '{}'); return basename(pr.unet_name || pr.clip_name || ''); } catch { return '-'; }
      },
      async refreshQueue() {
        try {
          const d = await api('GET', '/image/queue?source=zimage'); this.queue = d.jobs || [];
          if (this.qPage >= this.qTotalPages) this.qPage = this.qTotalPages - 1; // 队列缩短时收拢页码
          // 切页回来：接续自己进行中的任务，页头进度条照常显示、耗时从 created_at 起算
          if (!this.busy) {
            const run = (this.queue || []).find((q) => (q.status === 'running' || q.status === 'pending') && q.user_id === store.user.id);
            if (run) {
              this.busy = true; this.statusText = run.status === 'pending' ? '排队中…' : '生成中…';
              this.startClock(Date.parse(String(run.created_at || '').replace(' ', 'T')) || undefined);
              this.poll(run.id);
            }
          }
        } catch (e) {}
      },
      async openFolder() { try { await api('POST', '/image/open-output-dir'); } catch (e) { alert(e.message); } },
      onGenMode() {
        // v1.0.36 生成模式：重绘放大=原图先拉到目标尺寸再 img2img 低 denoise（默认 1920×1080、
        // denoise 0.2——低重绘=AI 超分只补细节；>0.3 容易改画面/变脸/改构图）；
        // 纯超分=RealESRGAN 模型放大不重绘（默认目标 2560×1440）
        this._syncing = true;
        if (this.p.gen_mode === 'hires') {
          this.p.width = 1920; this.p.height = 1080; this.p.denoise = 0.2;
          this.ratioLock = '16:9'; this.ratio = 16 / 9; this.sizePreset = '1920x1080';
        } else if (this.p.gen_mode === 'upscale') {
          this.p.width = 2560; this.p.height = 1440;
          this.ratioLock = '16:9'; this.ratio = 16 / 9; this.sizePreset = '2560x1440';
        } else {
          this.p.denoise = 1.0;
        }
        this._syncing = false;
      },
      // 需求28 粘贴图片 → 重绘/超分原图（与选择原图/从系统选图同效）
      openPaste() { this.pasteOpen = true; },
      onPasteConfirm(list) {
        this.pasteOpen = false;
        const it = list && list[list.length - 1]; if (!it) return;
        this.hiresPreview = it.dataUrl; this.hiresImage = it.dataUrl; this.hiresExt = it.ext || 'png'; this.hiresName = it.name;
      },
      onHiresFile(e) {
        const f = e.target.files[0]; e.target.value = '';
        if (!f) return;
        const r = new FileReader();
        r.onload = () => { this.hiresPreview = r.result; this.hiresImage = r.result; this.hiresExt = f.name.split('.').pop(); this.hiresName = f.name; };
        r.readAsDataURL(f);
      },
      async loadPick() {
        // 从系统选图：文生图+广告图最近完成的产物（不带 source 过滤，普通用户只见自己的、管理员见全部）
        this.pickOpen = true; this.pickBusy = true;
        try {
          const d = await api('GET', '/image/queue');
          this.pickList = (d.jobs || []).filter((j) => j.status === 'done' && j.image_path).map((j) => {
            let wh = '', mode = '';
            try {
              const pp = JSON.parse(j.params || '{}');
              if (pp.width && pp.height) wh = pp.width + '×' + pp.height;
              if (pp.gen_mode === 'hires') mode = '重绘'; else if (pp.gen_mode === 'upscale') mode = '超分';
            } catch (e) { /* 参数解析失败照样可选 */ }
            const file = basename(j.image_path);
            return { id: j.id, file, wh, mode, src: { ad: '分层图', h3: '文生图H3' }[j.source] || '文生图Z', url: authed('/api/image/output/' + file), prompt: String(j.prompt || '').slice(0, 40) };
          });
        } catch (e) { alert('拉取历史图失败：' + e.message); this.pickOpen = false; }
        this.pickBusy = false;
      },
      async pickOne(it) {
        this.pickBusy = true;
        try {
          const r = await fetch(it.url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const blob = await r.blob();
          const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读取失败')); fr.readAsDataURL(blob); });
          this.hiresPreview = dataUrl; this.hiresImage = dataUrl;
          this.hiresExt = (it.file.split('.').pop() || 'png');
          this.hiresName = it.file;
          this.pickOpen = false;
        } catch (e) { alert('选图失败：' + e.message); }
        this.pickBusy = false;
      },
      // v1.0.39 批量生成：逐段提交（串行 await，共用参数区设置；denoise 强制 1.0=纯文生图）
      openBatch() { this.batchOpen = true; },
      closeBatch() { if (!this.batchBusy) this.batchOpen = false; },
      async submitBatch() {
        const list = this.batchList;
        if (!list.length || this.batchBusy) return;
        this.batchBusy = true; this.batchDone = 0;
        const _busy = await busyBefore();
        let ok = 0; const fails = [];
        for (const it of list) {
          try {
            const body = {
              prompt: it.text, negative_prompt: this.p.negative,
              clip_name: this.p.clip_name, clip_type: this.p.clip_type, clip_device: this.p.clip_device,
              vae_name: this.p.vae_name, unet_name: this.p.unet_name, weight_dtype: this.p.weight_dtype,
              width: this.p.width, height: this.p.height, batch_size: this.p.batch_size, shift: this.p.shift,
              seed: this.p.seed, steps: this.p.steps, cfg: this.p.cfg,
              sampler_name: this.p.sampler_name, scheduler: this.p.scheduler, denoise: 1.0,
              gen_mode: 't2i', source: 'zimage',
            };
            await api('POST', '/image/generate', body);
            ok++;
          } catch (e) {
            fails.push(it.title + '：' + e.message);
            if (String(e.message || '').includes('上限')) break; // 额度用完，后面提交也一样，不空转
          }
          this.batchDone++;
        }
        this.batchBusy = false;
        if (ok) { this.refreshQueue(); queueBusyNotice(_busy); }
        this.statusText = ok ? '批量已提交 ' + ok + ' 个任务' : '';
        alert('批量提交完成：成功 ' + ok + ' 个' + (fails.length ? '，失败 ' + fails.length + ' 个：\n' + fails.join('\n') : '，已在队列排队执行。'));
      },
      // v1.0.41 负向提示词快捷键：追加人物/广告图词组（可叠加、重复添加拦截）、一键清空
      addNeg(kind) {
        const list = kind === 'person' ? NEG_PRESETS.person : NEG_PRESETS.ad;
        const cur = String(this.p.negative || '').trim();
        if (cur.includes(list)) return;
        this.p.negative = cur ? cur.replace(/[，,]\s*$/, '') + '，' + list : list;
      },
      clearNeg() { this.p.negative = ''; },
      async go() {
        const mode = this.p.gen_mode || 't2i';
        if (mode === 't2i' && !this.p.prompt.trim()) { alert('请输入正向提示词'); return; }
        if (mode !== 't2i' && !this.hiresImage) { alert('请先选择原图'); return; }
        this.busy = true; this.job = null; this.statusText = '提交中…'; this.pctHigh = 0; this.startClock();
        try {
          const body = {
            prompt: this.p.prompt, negative_prompt: this.p.negative,
            clip_name: this.p.clip_name, clip_type: this.p.clip_type, clip_device: this.p.clip_device,
            vae_name: this.p.vae_name, unet_name: this.p.unet_name, weight_dtype: this.p.weight_dtype,
            width: this.p.width, height: this.p.height, batch_size: this.p.batch_size, shift: this.p.shift,
            seed: this.p.seed, steps: this.p.steps, cfg: this.p.cfg,
            sampler_name: this.p.sampler_name, scheduler: this.p.scheduler, denoise: this.p.denoise,
            gen_mode: mode, upscale_method: this.p.upscale_method,
            image: mode !== 't2i' ? { data: this.hiresImage, ext: this.hiresExt } : undefined,
            source: 'zimage',
          };
          const _busy = await busyBefore();
          const d = await api('POST', '/image/generate', body);
          this.poll(d.id); this.refreshQueue(); queueBusyNotice(_busy);
        } catch (e) { alert(e.message); this.statusText = ''; this.busy = false; this.stopClock(); }
      },
      poll(id) {
        this.timer = setInterval(async () => {
          try {
            const d = await api('GET', '/image/job/' + id);
            this.job = d.job;
            const p = Number(d.job.progress_pct);
            if (Number.isFinite(p)) this.pctHigh = Math.max(this.pctHigh, Math.min(100, p));
            if (d.job.status === 'done') { this.statusText = '完成'; this.busy = false; this.stopClock(); clearInterval(this.timer); this.refreshQueue(); }
            else if (d.job.status === 'failed') { this.statusText = '失败'; this.busy = false; this.stopClock(); clearInterval(this.timer); this.refreshQueue(); }
            else this.statusText = d.job.progress || (d.job.status === 'pending' ? '排队中…' : '生成中…');
          } catch (e) { clearInterval(this.timer); this.busy = false; this.stopClock(); this.statusText = ''; }
        }, 3000);
      },
      // v1.0.14 第13条：页头停止按钮（任务中心同款安全语义：排队中出队、执行中核实后打断）
      async stopJob() {
        if (!this.job || !this.job.id) { alert('任务刚提交、还没登记好，1-2 秒后再点停止'); return; }
        try { await api('POST', '/tasks/zimage/' + this.job.id + '/stop'); this.statusText = '停止中…'; }
        catch (e) { alert(e.message); }
      },
      // v1.0.15：点开放大查看，← → 在全部已完成图片间前后翻页（不限缩略图条的当前页）
      zoomImg(im) {
        const items = this.doneImages.map((q) => ({ kind: 'image', url: this.imgUrl(q), title: q.prompt || '', sub: '#' + q.id + ' · ' + (q.created_at || '') }));
        openViewer(items, this.doneImages.indexOf(im));
      },
    },
    beforeUnmount() { if (this.timer) clearInterval(this.timer); if (this.qTimer) clearInterval(this.qTimer); },
  };

  // ---------- 文生图H3（MiniMax-H3-Image，v1.0.44） ----------
  // 需求19：复制文生图页骨架、节点全部换成 H3-Image 管线（Image Studio），预留 int8 切换位
  //（int8_convrot 默认 / GGUF Q4_0 预留 / P-H3 w4a8 小显存预留）。
  // 需求20：参考图上传 + 从本系统历史生成图中选（第一张=源图，其余=参考图2..9，上限 9 张）；
  // 有参考图时自动切参考图编辑（ref2va 模型，提示词=编辑指令），无参考图=纯文生图（fl2va + Turbo LoRA）。
  const H3Image = {
    template: `
    <div>
      <div class="page-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
        <div style="min-width:0"><h2>文生图H3</h2><div class="desc">MiniMax-H3-Image：fl2va int8_convrot + Turbo LoRA；带参考图自动切参考图编辑（ref2va）。需 ComfyUI ≥ 0.37（设置 → 后端升级检测）</div></div>
        <div style="flex:none;display:flex;align-items:center;gap:12px">
          <div v-if="job || statusText" style="width:320px;max-width:38vw">
            <div class="progress"><div :style="{ width: showPct + '%', background: (job && job.status === 'failed') ? 'var(--danger)' : undefined }"></div></div>
            <div class="muted" style="display:flex;align-items:center;gap:8px;margin-top:4px;white-space:nowrap;font-size:12px">
              <span v-if="busy" class="spin"></span><b>{{ showPct }}%</b><span v-if="elapsedText">{{ elapsedText }}</span><span class="ellip" :title="progressText">{{ progressText }}</span>
            </div>
          </div>
          <button class="btn primary" :disabled="busy" @click="go">{{ busy ? '生成中' : '开始生成' }}</button>
          <button class="btn" :disabled="busy || batchBusy" @click="openBatch" title="粘贴多段提示词（每段以「## 图1」标题行分隔），一键批量提交多个任务排队执行">批量生成</button>
          <button v-if="busy" class="btn danger" @click="stopJob" title="停止当前任务（排队中的直接出队，执行中的安全打断）">停止</button>
        </div>
      </div>
      <div v-if="job && job.error" class="alert err" style="margin-bottom:12px">{{ job.error }}</div>

      <div class="card">
        <h3 style="margin:0 0 12px">功能控制框</h3>
        <div class="grid-2">
          <div class="field"><label>正向提示词{{ refs.length ? '（编辑指令：说明怎么改源图，可用 <Picture 1>/<Picture 2> 指代图片）' : '（必填）' }}</label><textarea v-model="p.prompt" style="min-height:140px"></textarea></div>
          <div class="field"><label>负向提示词（H3 模型无负面条件输入，仅随任务记录保存，不参与生成）</label>
            <div style="display:flex;gap:6px;margin-bottom:6px">
              <button class="btn sm" type="button" @click="p.negative = ''" title="清空负向提示词">清空</button>
            </div>
            <textarea v-model="p.negative" style="min-height:140px"></textarea></div>
        </div>
        <div class="row">
          <div class="field"><label>模型变体（int8 切换位）</label>
            <select v-model="p.variant">
              <option value="int8">int8_convrot（默认 · 全质量）</option>
              <option value="gguf">GGUF Q4_0（预留 · 换核后开放）</option>
              <option value="ph3">P-H3 w4a8 小显存（预留 · 节点包待装）</option>
            </select>
          </div>
          <div class="field"><label>采样档位（Turbo LoRA 与配方成对，不可混搭）</label>
            <select v-model="p.turbo" :disabled="!!refs.length" :title="refs.length ? '参考图编辑固定 base 20 步（ref2v Turbo 未配）' : ''">
              <option value="8">Turbo 8 步（默认）</option>
              <option value="4">Turbo 4 步（v1.2 配方）</option>
              <option value="off">base 20 步（最稳）</option>
            </select>
          </div>
          <div class="field"><label>画面比例</label>
            <select v-model="p.aspect_ratio">
              <option v-for="a in aspectList" :key="a" :value="a">{{ a }}</option>
              <option v-if="refs.length" value="source image">source image（跟随源图）</option>
              <option value="custom">自定义尺寸（自由宽高）</option>
            </select>
          </div>
          <div class="field"><label>分辨率档位</label>
            <select v-model="p.resolution_profile" :disabled="p.aspect_ratio === 'custom'" :title="p.aspect_ratio === 'custom' ? '自定义尺寸下分辨率档位不参与（宽高直接生效）' : ''"><option v-for="r in resList" :key="r" :value="r">{{ r }}</option></select>
          </div>
          <div class="field"><label>质量档位（潜在帧数：多帧更稳更慢）</label>
            <select v-model="p.quality_profile" title="1 帧档自动配图像 VAE（更锐、最快）；5/9/13/20 帧档采样多帧后帧选优，自动配视频 VAE"><option v-for="q in qualList" :key="q" :value="q">{{ q }}</option></select>
          </div>
          <div class="field"><label>种子（-1 随机）</label><input v-model="p.seed" /></div>
          <div class="field"><label>种子策略</label>
            <select v-model="p.control_after_generate" title="批量大于 1 时：fixed=每张同种子，increment/decrement=逐张 ±1">
              <option value="randomize">randomize（每张随机）</option>
              <option value="fixed">fixed（固定复现）</option>
              <option value="increment">increment（逐张 +1）</option>
              <option value="decrement">decrement（逐张 -1）</option>
            </select>
          </div>
          <div class="field"><label>批量大小（1-8 张）</label><input type="number" min="1" max="8" v-model.number="p.batch_size" /></div>
          <div class="field" v-if="refs.length" style="min-width:220px"><label>源图保真度（{{ p.source_fidelity }} · 低=敢改，高=守形）</label><input type="range" min="0" max="1" step="0.05" v-model.number="p.source_fidelity" style="width:100%" /></div>
          <div class="field" style="min-width:0;flex:none;display:flex;align-items:flex-end;padding-bottom:4px">
            <label class="chk" style="display:flex;align-items:center;gap:6px;white-space:nowrap"><input type="checkbox" v-model="p.optimize_for_still" /> 静图优化（optimize_for_still）</label>
          </div>
        </div>

        <div class="row" style="margin-top:12px">
          <div class="field"><label>图像宽度（32 的倍数，自动圆整{{ p.aspect_ratio === 'custom' ? '' : ' · 选「自定义尺寸」后可填' }}）</label><input type="number" min="256" max="16384" step="32" v-model.number="p.width" :disabled="p.aspect_ratio !== 'custom'" /></div>
          <div class="field"><label>图像高度（32 的倍数，自动圆整{{ p.aspect_ratio === 'custom' ? '' : ' · 选「自定义尺寸」后可填' }}）</label><input type="number" min="256" max="16384" step="32" v-model.number="p.height" :disabled="p.aspect_ratio !== 'custom'" /></div>
          <div class="field" style="min-width:0;flex:none;display:flex;align-items:flex-end;padding-bottom:4px">
            <button class="btn sm" :disabled="p.aspect_ratio !== 'custom'" @click="swapSize" title="宽高互换">⇄ 互换</button>
          </div>
          <div class="field"><label>常用尺寸</label>
            <select v-model="sizePreset" :disabled="p.aspect_ratio !== 'custom'" @change="applyPreset"><option value="">— 手动输入 —</option><option v-for="s in sizePresets" :key="s.v" :value="s.v">{{ s.label }}</option></select>
          </div>
          <div class="field"><label>锁定比例</label>
            <select v-model="ratioLock" :disabled="p.aspect_ratio !== 'custom'" @change="onRatioLock">
              <option value="">不锁定</option>
              <option value="16:9">16:9</option>
              <option value="4:3">4:3</option>
            </select>
          </div>
          <div class="muted" style="align-self:center;font-size:12px;flex:1;min-width:200px">范围 256~16384，提交时按 32 圆整；画面比例选预设档（1:1、16:9…）时由官方节点按分辨率档位算尺寸，宽高框置灰。</div>
        </div>

        <details style="margin:14px 0 0" v-if="true">
          <summary style="cursor:pointer;font-weight:600;font-size:13px">模型与高级参数（ComfyUI 装载器，一般无需改动）</summary>
          <div class="row" style="margin-top:10px">
            <div class="field"><label>主模型（int8_convrot · unet_name）</label><input v-model="p.unet_name" /></div>
            <div class="field"><label>参考图模型（ref2va int8 · ref_unet_name）</label><input v-model="p.ref_unet_name" /></div>
            <div class="field"><label>GGUF 模型（预留 · unet_gguf）</label><input v-model="p.unet_gguf" /></div>
          </div>
          <div class="row">
            <div class="field"><label>文本编码器（CLIP · clip_name）</label><input v-model="p.clip_name" /></div>
            <div class="field"><label>VAE 模型（vae_name · 随质量档位联动）</label>
              <select v-model="p.vae_name" title="质量档位选 1 帧自动配图像 VAE（更锐），多帧档自动配视频 VAE；手动改后切档位会重新联动；后端缺文件时生成会自动回退视频 VAE">
                <option value="minimax_h3_t1_image_vae_step1597.safetensors">minimax_h3_t1_image_vae_step1597（图像 VAE · 1 帧档专用，更锐）</option>
                <option value="minimax_h3_video_vae_fp16.safetensors">minimax_h3_video_vae_fp16（视频 VAE · 多帧档）</option>
              </select>
            </div>
            <div class="field" style="min-width:180px"><label>帧选优相似度权重（留空=自动：文生图 0.6 / 参考编辑 0.35）</label><input v-model="p.similarity_weight" placeholder="留空=自动" /></div>
            <div class="field" style="max-width:140px"><label>帧选优 top_k</label><input type="number" min="1" max="20" v-model.number="p.top_k" /></div>
          </div>
          <div class="muted" style="font-size:12px;margin-top:6px">采样说明：H3 的「采样器」= 采样档位配方（Turbo LoRA 与步数成对，官方明确警告不可混搭），ComfyUI 侧无自由 steps/CFG/scheduler 输入框；当前配方 LoRA：{{ turboLora }}。</div>
        </details>

        <h3 style="margin:18px 0 8px">参考图 <span class="muted" style="font-weight:400;font-size:12px">（第一张=源图，最多再选 8 张=参考图 2..9；不选 = 纯文生图）</span></h3>
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
          <div v-for="(r, i) in refs" :key="i" style="position:relative;width:86px;height:86px;border:1px solid rgba(128,128,128,.35);border-radius:8px;overflow:hidden;flex:none">
            <img :src="r.dataUrl" style="width:100%;height:100%;object-fit:cover;cursor:zoom-in" :title="r.name" @click="zoomRef(i)" />
            <button class="btn sm" style="position:absolute;top:2px;right:2px;padding:0 6px;line-height:20px" @click="rmRef(i)" title="移除">✕</button>
            <div style="position:absolute;left:0;bottom:0;right:0;background:rgba(0,0,0,.55);color:#fff;font-size:11px;text-align:center;padding:1px 0">{{ i === 0 ? '源图' : '参考' + (i + 1) }}</div>
          </div>
          <button class="btn sm" @click="$refs.refFile.click()">上传图片</button>
          <input ref="refFile" type="file" accept="image/*" multiple style="display:none" @change="onRefFiles" />
          <button class="btn sm" @click="loadPick">从系统选图</button>
          <button class="btn sm" @click="openPaste" title="粘贴剪贴板图片（Ctrl+V，可连续多张）">粘贴图片</button>
          <span class="muted" style="font-size:12px">来源：本地上传 / 本系统历史生成图（文生图Z · 分层图 · 文生图H3）/ 剪贴板粘贴</span>
        </div>

        <div v-if="pickOpen" class="overlay" @click.self="pickOpen = false">
          <div class="card" style="max-width:880px;width:94vw;max-height:82vh;overflow:auto">
            <h3 style="margin:0 0 10px">从系统选图（最近完成的生成图）</h3>
            <div v-if="pickBusy" style="padding:24px;text-align:center;opacity:.7">加载中…</div>
            <div v-else-if="!pickList.length" style="padding:24px;text-align:center;opacity:.7">还没有已完成的生成图</div>
            <div v-else style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
              <div v-for="it in pickList" :key="it.id" title="点选此图" style="cursor:pointer;border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:6px;text-align:center" @click="pickOne(it)">
                <img :src="it.url" style="width:100%;height:92px;object-fit:cover;border-radius:4px" />
                <div style="font-size:12px;margin-top:4px">{{ it.src }}<span v-if="it.mode"> · {{ it.mode }}</span></div>
                <div style="font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ it.prompt || it.file }}</div>
              </div>
            </div>
            <div style="margin-top:12px;text-align:right"><button class="btn sm" @click="pickOpen = false">取消</button></div>
          </div>
        </div>
        <!-- 需求28 粘贴图片：参考图（可多张，追加进 refs，与上传/系统选图同效） -->
        <PasteDlg v-if="pasteOpen" title="粘贴图片（参考图，可多张）" :multi="true" @confirm="onPasteConfirm" @close="pasteOpen = false" />

        <!-- v1.0.45 批量生成：粘贴「## 图N」分段提示词，一键提交多个 H3 任务（对齐文生图Z） -->
        <div v-if="batchOpen" class="overlay" @click.self="closeBatch">
          <div class="card" style="max-width:860px;width:94vw;max-height:86vh;overflow:auto">
            <h3 style="margin:0 0 10px">批量生成（文生图H3）</h3>
            <div class="muted" style="margin-bottom:8px;font-size:12px">粘贴多段提示词，每段前面加一行以分割关键词开头的标题（默认「## 图1」「## 图2」…）。每段提交为一个独立任务（每段 1 张），共用当前参数区的尺寸 / 档位等设置，按顺序自动排队执行。带参考图的批量走参考图编辑模式（参考图共用当前已选）。</div>
            <div class="row" style="align-items:center;margin-bottom:8px;flex-wrap:wrap">
              <label style="flex:none;font-size:13px;font-weight:600">分割关键词</label>
              <input v-model="batchSep" style="width:170px" placeholder="## 图" title="以该关键词开头的行视为一段的标题行" />
              <span class="muted" style="flex:1;min-width:220px;font-size:12px">以该关键词开头的行 = 新一段的开始；留空用默认「## 图」</span>
            </div>
            <textarea v-model="batchText" style="width:100%;min-height:300px;font-size:13px" placeholder="## 图1&#10;1、场景环境：…&#10;2、人物姿态：…&#10;&#10;## 图2&#10;1、场景环境：…"></textarea>
            <div v-if="batchText.trim()" class="row" style="align-items:center;margin-top:8px;flex-wrap:wrap">
              <b style="flex:none">解析出 {{ batchList.length }} 个任务</b>
              <span v-if="!batchList.length" class="alert err" style="margin:0;flex:1">没识别到分段：每段提示词前需要一行以分割关键词开头的标题行（当前「{{ batchSep || '## 图' }}」）</span>
              <span v-else class="muted ellip" style="flex:1;font-size:12px" :title="batchList.map(t=>t.title).join(' / ')">{{ batchList.map(t=>t.title).join(' / ') }}</span>
            </div>
            <div style="margin-top:12px;text-align:right">
              <button class="btn sm" :disabled="batchBusy" @click="closeBatch">取消</button>
              <button class="btn sm primary" style="margin-left:8px" :disabled="batchBusy || !batchList.length" @click="submitBatch">{{ batchBusy ? '提交中 ' + batchDone + '/' + batchList.length + '…' : '一键提交 ' + batchList.length + ' 个任务' }}</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>最近生成图
          <button class="btn sm" style="margin-left:10px" @click="openFolder">打开文件夹</button>
          <span class="muted" style="margin-left:10px">共 {{ doneImages.length }} 张</span>
          <button class="btn sm" style="margin-left:10px" :disabled="stripPage<=0" @click="stripPage--">‹</button>
          <button class="btn sm" :disabled="(stripPage+1)*stripSize>=doneImages.length" @click="stripPage++">›</button>
        </h3>
        <div v-if="!doneImages.length" class="muted">暂无已完成的图片</div>
        <div v-else class="img-strip">
          <div v-for="im in stripSlice" :key="im.id" class="img-strip-card" :title="im.prompt || ''">
            <img :src="imgUrl(im)" style="cursor:zoom-in" @click="zoomImg(im)" />
            <div class="vmeta"><span class="muted">#{{ im.id }}</span><a class="btn sm" :href="imgUrl(im)" download>下载</a></div>
          </div>
        </div>
        <div v-if="doneImages.length > stripSize" class="muted" style="margin-top:6px">点图片可放大，放大后 ← → 翻看全部 {{ doneImages.length }} 张</div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>任务队列详情</h3>
        <div v-if="!queue.length" class="muted">队列为空</div>
        <table v-else class="tbl">
          <thead><tr><th>序号</th><th>提示词</th><th>尺寸</th><th>状态</th><th>过程</th><th>耗时</th><th>使用模型</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="q in queuePage" :key="q.id">
              <td>{{ q.id }}</td>
              <td class="ellip" :title="q.prompt">{{ q.prompt || '-' }}</td>
              <td>{{ whOf(q) }}</td>
              <td><span class="badge" :class="typeBadge(q.status)">{{ statusLabel(q.status) }}</span></td>
              <td class="ellip" :title="q.progress">{{ q.progress || '-' }}</td>
              <td class="muted">{{ fmtDur(q.duration_ms) }}</td>
              <td class="ellip" :title="modelOf(q)">{{ modelOf(q) }}</td>
              <td style="white-space:nowrap">
                <button class="btn sm" @click="regen(q)" title="把该任务的参数还原到上方参数框（参考图需重选）">再生成</button>
                <a v-if="q.image_path" class="btn sm" :href="authed('/api/image/output/' + basename(q.image_path))" download>下载</a>
                <a class="btn sm" :href="authed('/api/image/workflow/' + q.id)">工作流</a>
                <span v-if="q.status==='failed'" style="color:var(--danger)">{{ q.error }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="queue.length > qPageSize || qPage > 0" class="row" style="flex:none;justify-content:flex-end;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">
          <span class="muted">共 {{ queue.length }} 条</span>
          <select v-model.number="qPageSize" @change="qPage = 0" style="width:auto">
            <option>10</option><option>20</option><option>30</option><option>50</option><option>100</option>
          </select>
          <span class="muted">条/页</span>
          <button class="btn sm" :disabled="qPage <= 0" @click="qPage--">‹ 上一页</button>
          <span class="muted">{{ qPage + 1 }} / {{ qTotalPages }}</span>
          <button class="btn sm" :disabled="(qPage + 1) * qPageSize >= queue.length" @click="qPage++">下一页 ›</button>
        </div>
      </div>
    </div>`,
    data() {
      return {
        p: { prompt: '', negative: '', variant: 'int8', turbo: '8', aspect_ratio: 'custom', resolution_profile: 'native detail | 0.98 MP', quality_profile: 'single image | 1 frame (image VAE)', optimize_for_still: true, seed: -1, source_fidelity: 0.6, width: 1920, height: 1080, batch_size: 1, control_after_generate: 'randomize',
             unet_name: '', ref_unet_name: '', unet_gguf: '', clip_name: '', vae_name: '', similarity_weight: '', top_k: 4 }, // 需求25 模型与高级参数；aspect 默认 custom（宽高框常显可填）
        refs: [],            // [{ name, dataUrl, ext, data }]（data=base64，提交用；文件大不进 params）
        ratioLock: '', ratio: 0, _syncing: false, sizePreset: '', sizePresets: SIZE_PRESETS,
        aspectList: ['1:1 square', '4:5 portrait', '3:4 portrait', '2:3 portrait', '9:16 portrait', '16:9 landscape', '3:2 landscape', '4:3 landscape', '21:9 ultrawide'],
        resList: ['fast preview | 0.40 MP', 'balanced | 0.70 MP', 'high | 0.90 MP', 'native detail | 0.98 MP', 'high-res | 2.00 MP', 'ultra | 4.00 MP', 'ultra+ | 8.00 MP'],
        qualList: ['single image | 1 frame (image VAE)', 'recommended | 5 frames', 'extended quality | 9 frames', 'high quality | 13 frames', 'maximum quality | 20 frames (slow)'],
        pickOpen: false, pickBusy: false, pickList: [],
        pasteOpen: false, // 需求28 粘贴图片（参考图多张）
        batchOpen: false, batchText: '', batchBusy: false, batchDone: 0, batchSep: '## 图', // v1.0.45 批量生成（对齐文生图Z）
        busy: false, statusText: '', job: null, timer: null, now: 0,
        queue: [], qTimer: null, stripPage: 0, stripSize: 10, qPage: 0, qPageSize: 10, pctHigh: 0,
        _clock: null, _t0: 0,
      };
    },
    computed: {
      doneImages() { return (this.queue || []).filter((q) => q.status === 'done' && q.image_path); },
      stripSlice() { const s = this.stripPage * this.stripSize; return this.doneImages.slice(s, s + this.stripSize); },
      qTotalPages() { return Math.max(1, Math.ceil((this.queue || []).length / this.qPageSize)); },
      queuePage() { return (this.queue || []).slice(this.qPage * this.qPageSize, (this.qPage + 1) * this.qPageSize); },
      // v1.0.45 批量生成解析（同文生图Z）：以 batchSep 开头的行 = 标题行
      batchList() {
        const sep = String(this.batchSep || '').trim() || '## 图';
        const lines = String(this.batchText || '').split(/\r?\n/);
        const out = []; let cur = null;
        for (const ln of lines) {
          if (ln.trim().startsWith(sep.trim())) {
            if (cur) out.push(cur);
            cur = { title: ln.trim().replace(/^#{1,6}\s+/, '').trim() || ('任务' + (out.length + 1)), text: '' };
          } else if (cur) cur.text += (cur.text ? '\n' : '') + ln;
        }
        if (cur) out.push(cur);
        return out.filter((t) => { t.text = t.text.trim(); return t.text; });
      },
      jobProgressPct() {
        if (!this.job) return 0;
        if (this.job.status === 'done' || this.job.status === 'failed') return 100;
        const n = Number(this.job.progress_pct);
        return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
      },
      showPct() { return Math.max(this.pctHigh, this.jobProgressPct); }, // 只进不退（同文生图Z 防抖）
      progressText() {
        if (this.job && this.job.progress) return this.job.progress;
        if (this.job && this.job.status === 'failed') return '生成失败';
        return this.statusText || '准备中…';
      },
      elapsedText() {
        if (!this.busy || !this._t0) return '';
        const s = Math.max(0, Math.floor(((this.now || Date.now()) - this._t0) / 1000));
        return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
      },
      turboLora() {
        if (this.refs.length) return '参考图编辑固定 base 20 步（无 LoRA）';
        return { 8: 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16', 4: 'minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16', off: 'base 20 步（无 LoRA）' }[this.p.turbo] || '-';
      },
    },
    async mounted() {
      this.loadDefaults();
      this.refreshQueue();
      this.qTimer = setInterval(() => this.refreshQueue(), 3000);
    },
    beforeUnmount() { if (this.timer) clearInterval(this.timer); if (this.qTimer) clearInterval(this.qTimer); if (this._clock) clearInterval(this._clock); },
    watch: {
      // 需求31 互锁：质量档位切换 → VAE 跟随（1 帧档=图像 VAE 更锐，多帧档=视频 VAE）；「自动」也切成对应文件（后端有文件缺失兜底）
      'p.quality_profile': {
        handler() { this.syncVae(); },
      },
      // 自定义尺寸锁比联动（同文生图Z：_syncing 防回环，flush sync 保证即时）
      'p.width': { flush: 'sync', handler(v) { if (this._syncing) return; this.sizePreset = ''; if (this.ratioLock && this.ratio && Number(v) > 0) { this._syncing = true; this.p.height = Math.round(Number(v) / this.ratio); this._syncing = false; } } },
      'p.height': { flush: 'sync', handler(v) { if (this._syncing) return; this.sizePreset = ''; if (this.ratioLock && this.ratio && Number(v) > 0) { this._syncing = true; this.p.width = Math.round(Number(v) * this.ratio); this._syncing = false; } } },
    },
    methods: {
      authed, basename,
      startClock(fromTs) { this._t0 = fromTs || Date.now(); if (!this._clock) this._clock = setInterval(() => { this.now = Date.now(); }, 1000); this.now = Date.now(); },
      stopClock() { if (this._clock) { clearInterval(this._clock); this._clock = null; } },
      statusLabel(s) { return { pending: '排队中', running: '生成中', done: '完成', failed: '失败' }[s] || s; },
      typeBadge(s) { return { done: 'ok', failed: 'err', running: 'warn', pending: 'dim' }[s] || 'dim'; },
      fmtDur(ms) {
        if (!ms || ms <= 0) return '-';
        if (ms < 1000) return ms + 'ms';
        if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
        const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
        return m + 'm' + (s ? s + 's' : '');
      },
      modeOf(q) { try { return (JSON.parse(q.params || '{}').mode === 'refedit') ? '参考图编辑' : '文生图'; } catch { return '-'; } },
      whOf(q) { try { const pp = JSON.parse(q.params || '{}'); if (pp.width && pp.height) return pp.width + '×' + pp.height; return String(pp.aspect_ratio || '-').split(' ')[0]; } catch { return '-'; } },
      modelOf(q) {
        try {
          const pp = JSON.parse(q.params || '{}');
          const v = { int8: 'fl2va int8', gguf: 'GGUF Q4_0', ph3: 'P-H3 w4a8' }[pp.variant] || pp.variant || 'int8';
          const t = { '8': 'Turbo8', '4': 'Turbo4', off: 'base20' }[pp.turbo] || pp.turbo || '';
          return pp.mode === 'refedit' ? 'ref2va int8 · base20' : (v + ' · ' + t);
        } catch { return '-'; }
      },
      imgUrl(q) { return authed('/api/image/output/' + basename(q.image_path)); },
      zoomImg(im) {
        const items = this.doneImages.map((q) => ({ kind: 'image', url: this.imgUrl(q), title: q.prompt || '', sub: '#' + q.id + ' · ' + (q.created_at || '') }));
        openViewer(items, this.doneImages.indexOf(im));
      },
      openBatch() { this.batchOpen = true; },
      closeBatch() { if (!this.batchBusy) this.batchOpen = false; },
      async submitBatch() {
        const list = this.batchList;
        if (!list.length || this.batchBusy) return;
        this.batchBusy = true; this.batchDone = 0;
        const _busy = await busyBefore();
        let ok = 0; const fails = [];
        for (const it of list) {
          try {
            const body = {
              prompt: it.text, negative_prompt: this.p.negative, source: 'h3',
              variant: this.p.variant, turbo: this.p.turbo,
              aspect_ratio: this.p.aspect_ratio, resolution_profile: this.p.resolution_profile, quality_profile: this.p.quality_profile,
              optimize_for_still: this.p.optimize_for_still, seed: this.p.seed, source_fidelity: this.p.source_fidelity,
              batch_size: 1, control_after_generate: this.p.control_after_generate || 'randomize',
              ...(this.p.aspect_ratio === 'custom' ? { width: Math.round(Number(this.p.width) || 1024), height: Math.round(Number(this.p.height) || 1024) } : {}),
              unet_name: this.p.unet_name, ref_unet_name: this.p.ref_unet_name, unet_gguf: this.p.unet_gguf,
              clip_name: this.p.clip_name, vae_name: this.p.vae_name,
              similarity_weight: String(this.p.similarity_weight ?? '').trim() === '' ? '' : Number(this.p.similarity_weight),
              top_k: Math.max(1, Math.min(20, Math.floor(Number(this.p.top_k) || 4))),
              images: this.refs.map((r) => ({ data: r.data, ext: r.ext })),
            };
            await api('POST', '/image/generate', body);
            ok++;
          } catch (e) { fails.push(it.title + '：' + e.message); }
          this.batchDone++;
        }
        this.batchBusy = false;
        this.refreshQueue(); queueBusyNotice(_busy);
        if (fails.length) alert('批量提交完成：成功 ' + ok + ' 个，失败 ' + fails.length + ' 个\n' + fails.join('\n'));
        else { this.batchOpen = false; this.statusText = '批量提交完成（' + ok + ' 个任务已排队）'; }
      },
      // ---- 自定义尺寸（与文生图Z 同机制）----
      applyPreset() {
        const v = this.sizePreset; if (!v) return;
        const [w, h] = v.split('x').map(Number);
        this._syncing = true; this.p.width = w; this.p.height = h; this._syncing = false;
        this.detectLock();
      },
      onRatioLock() {
        const map = { '16:9': 16 / 9, '4:3': 4 / 3 };
        this.ratio = map[this.ratioLock] || 0;
        if (this.ratio && Number(this.p.width) > 0) { this._syncing = true; this.p.height = Math.round(Number(this.p.width) / this.ratio); this._syncing = false; }
      },
      detectLock() {
        const r = Number(this.p.height) > 0 ? Number(this.p.width) / Number(this.p.height) : 0;
        if (Math.abs(r - 16 / 9) < 0.02) { this.ratioLock = '16:9'; this.ratio = 16 / 9; }
        else if (Math.abs(r - 4 / 3) < 0.02) { this.ratioLock = '4:3'; this.ratio = 4 / 3; }
        else { this.ratioLock = ''; this.ratio = 0; }
      },
      swapSize() { const w = this.p.width; this._syncing = true; this.p.width = this.p.height; this.p.height = w; this._syncing = false; this.detectLock(); },
      // 需求31：按质量档位配对 VAE（当前值是「自动」或两件官方 VAE 之一时才联动；手选了别的就不动）
      syncVae() {
        const IMG = 'minimax_h3_t1_image_vae_step1597.safetensors', VID = 'minimax_h3_video_vae_fp16.safetensors';
        const pair = String(this.p.quality_profile || '').includes('1 frame') ? IMG : VID;
        if (['', IMG, VID].includes(this.p.vae_name) && this.p.vae_name !== pair) this.p.vae_name = pair;
      },
      async loadDefaults() {
        try {
          const d = await api('GET', '/image/h3-defaults');
          if (d.prompt && !this.p.prompt) this.p.prompt = d.prompt;
          if (d.negative && !this.p.negative) this.p.negative = d.negative; // 需求23 预置负面词
          for (const k of ['variant', 'turbo', 'aspect_ratio', 'resolution_profile', 'quality_profile', 'source_fidelity', 'batch_size', 'control_after_generate', 'width', 'height', 'unet_name', 'ref_unet_name', 'unet_gguf', 'clip_name', 'vae_name', 'top_k']) if (d[k] !== undefined) this.p[k] = d[k];
          if (d.optimize_for_still !== undefined) this.p.optimize_for_still = !!d.optimize_for_still;
          // 需求24：默认 1920×1080 → 常用尺寸下拉同步选中 FHD，比例恰好 16:9 时自动锁定（同文生图Z）
          if (this.p.width && this.p.height) {
            this.detectLock();
            this.sizePreset = matchPreset(this.p.width, this.p.height);
          }
          this.syncVae(); // 需求31：默认即按质量档位配对 VAE（默认 1 帧档 → 图像 VAE）
        } catch (e) { /* 后端不可达时保留默认值 */ }
      },
      onRefFiles(e) {
        const files = [...(e.target.files || [])]; e.target.value = '';
        for (const f of files) {
          if (this.refs.length >= 9) { alert('最多 9 张（源图 + 8 张参考图）'); break; }
          const ext = (f.name.split('.').pop() || 'png').toLowerCase();
          const r = new FileReader();
          r.onload = () => { if (this.refs.length < 9) this.refs.push({ name: f.name, dataUrl: r.result, ext, data: r.result }); };
          r.readAsDataURL(f);
        }
      },
      rmRef(i) { this.refs.splice(i, 1); },
      // 需求28 粘贴图片：多张追加进 refs（与上传图片同效：首张=源图，共 9 张上限）
      openPaste() { this.pasteOpen = true; },
      onPasteConfirm(list) {
        this.pasteOpen = false;
        if (!list || !list.length) return;
        for (const it of list) {
          if (this.refs.length >= 9) { alert('最多 9 张（源图 + 8 张参考图）'); break; }
          this.refs.push({ name: it.name, dataUrl: it.dataUrl, ext: it.ext, data: it.data });
        }
      },
      zoomRef(i) { openViewer([{ kind: 'image', url: this.refs[i].dataUrl, title: this.refs[i].name, sub: i === 0 ? '源图' : '参考' + (i + 1) }], 0); },
      async loadPick() {
        // 需求20：从系统选图——文生图Z/广告图/文生图H3 最近完成的产物（不带 source 过滤，普通用户只见自己的）
        this.pickOpen = true; this.pickBusy = true;
        try {
          const d = await api('GET', '/image/queue');
          this.pickList = (d.jobs || []).filter((j) => j.status === 'done' && j.image_path).map((j) => {
            let mode = '';
            try { mode = JSON.parse(j.params || '{}').mode === 'refedit' ? '参考编辑' : ''; } catch { }
            const file = basename(j.image_path);
            return { id: j.id, file, mode, src: { ad: '分层图', h3: '文生图H3' }[j.source] || '文生图Z', url: authed('/api/image/output/' + file), prompt: String(j.prompt || '').slice(0, 40) };
          });
        } catch (e) { alert('拉取历史图失败：' + e.message); this.pickOpen = false; }
        this.pickBusy = false;
      },
      async pickOne(it) {
        if (this.refs.length >= 9) { alert('最多 9 张（源图 + 8 张参考图）'); return; }
        this.pickBusy = true;
        try {
          const r = await fetch(it.url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const blob = await r.blob();
          const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读取失败')); fr.readAsDataURL(blob); });
          this.refs.push({ name: it.file, dataUrl, ext: (it.file.split('.').pop() || 'png'), data: dataUrl });
          this.pickOpen = false;
        } catch (e) { alert('选图失败：' + e.message); }
        this.pickBusy = false;
      },
      async refreshQueue() {
        try {
          const d = await api('GET', '/image/queue?source=h3'); this.queue = d.jobs || [];
          if (this.qPage >= this.qTotalPages) this.qPage = this.qTotalPages - 1;
          // 切页回来接续自己进行中的任务（同文生图Z）
          if (!this.busy) {
            const run = (this.queue || []).find((q) => (q.status === 'running' || q.status === 'pending') && q.user_id === store.user.id);
            if (run) {
              this.busy = true; this.statusText = run.status === 'pending' ? '排队中…' : '生成中…';
              this.startClock(Date.parse(String(run.created_at || '').replace(' ', 'T')) || undefined);
              this.poll(run.id);
            }
          }
        } catch (e) { }
      },
      async openFolder() { try { await api('POST', '/image/open-output-dir'); } catch (e) { alert(e.message); } },
      regen(q) {
        let pp = {};
        try { pp = JSON.parse(q.params || '{}'); } catch (e) { alert('该任务参数无法解析'); return; }
        this._syncing = true; // 整体写回：不让宽高互锁中途重算（同文生图Z）
        for (const k of Object.keys(this.p)) if (pp[k] !== undefined) this.p[k] = pp[k];
        this._syncing = false;
        this.p.prompt = String(q.prompt || '');
        this.p.negative = String(q.negative_prompt || '');
        const w = Number(this.p.width) || 0, h = Number(this.p.height) || 0;
        if (w > 0 && h > 0) this.detectLock();
        this.sizePreset = matchPreset(w, h); // 恰好等于某预设时下拉同步选中
        this.statusText = '已还原任务 #' + q.id + ' 的参数（参考图不随任务保存，需重新选择），确认后点「开始生成」';
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
      async go() {
        if (!String(this.p.prompt || '').trim()) { alert('请输入正向提示词'); return; }
        if (this.p.variant !== 'int8') { alert('该变体是预留切换位，暂未开放：先在「设置 → 后端升级检测」确认环境，等开放后无需改代码即可切换'); return; }
        this.busy = true; this.job = null; this.statusText = '提交中…'; this.pctHigh = 0; this.startClock();
        try {
          const body = {
            prompt: this.p.prompt, negative_prompt: this.p.negative, source: 'h3',
            variant: this.p.variant, turbo: this.p.turbo,
            aspect_ratio: this.p.aspect_ratio, resolution_profile: this.p.resolution_profile, quality_profile: this.p.quality_profile,
            optimize_for_still: this.p.optimize_for_still, seed: this.p.seed, source_fidelity: this.p.source_fidelity,
            batch_size: Math.max(1, Math.min(8, Number(this.p.batch_size) || 1)),
            control_after_generate: this.p.control_after_generate || 'randomize',
            ...(this.p.aspect_ratio === 'custom' ? { width: Math.round(Number(this.p.width) || 1024), height: Math.round(Number(this.p.height) || 1024) } : {}),
            unet_name: this.p.unet_name, ref_unet_name: this.p.ref_unet_name, unet_gguf: this.p.unet_gguf,
            clip_name: this.p.clip_name, vae_name: this.p.vae_name,
            similarity_weight: String(this.p.similarity_weight ?? '').trim() === '' ? '' : Number(this.p.similarity_weight),
            top_k: Math.max(1, Math.min(20, Math.floor(Number(this.p.top_k) || 4))),
            images: this.refs.map((r) => ({ data: r.data, ext: r.ext })),
          };
          const _busy = await busyBefore();
          const d = await api('POST', '/image/generate', body);
          this.poll(d.id); this.refreshQueue(); queueBusyNotice(_busy);
        } catch (e) { alert(e.message); this.statusText = ''; this.busy = false; this.stopClock(); }
      },
      poll(id) {
        this.timer = setInterval(async () => {
          try {
            const d = await api('GET', '/image/job/' + id);
            this.job = d.job;
            const n = Number(d.job.progress_pct);
            if (Number.isFinite(n)) this.pctHigh = Math.max(this.pctHigh, Math.min(100, n));
            if (d.job.status === 'done') { this.statusText = '完成'; this.busy = false; this.stopClock(); clearInterval(this.timer); this.refreshQueue(); }
            else if (d.job.status === 'failed') { this.statusText = '失败'; this.busy = false; this.stopClock(); clearInterval(this.timer); this.refreshQueue(); }
            else this.statusText = d.job.progress || (d.job.status === 'pending' ? '排队中…' : '生成中…');
          } catch (e) { clearInterval(this.timer); this.busy = false; this.stopClock(); this.statusText = ''; }
        }, 3000);
      },
      async stopJob() {
        if (!this.job || !this.job.id) { alert('任务刚提交、还没登记好，1-2 秒后再点停止'); return; }
        try { await api('POST', '/tasks/h3i/' + this.job.id + '/stop'); this.statusText = '停止中…'; }
        catch (e) { alert(e.message); }
      },
    },
  };

  // ---------- 分层图（需求29 更名，原「广告图」；Qwen-Image-Layered：文生分层图 + PSD 导出，v1.0.23） ----------
  const ZImageAd = {
    template: `
    <div>
      <div class="page-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
        <div style="min-width:0"><h2>分层图</h2><div class="desc">Qwen-Image-Layered 文生分层图：自动拆解 RGBA 透明图层 → 导出可编辑 .psd（Photoshop 打开即分层）</div></div>
        <div style="flex:none;display:flex;align-items:center;gap:12px">
          <div v-if="job || statusText" style="width:320px;max-width:38vw">
            <div class="progress"><div :style="{ width: showPct + '%', background: (job && job.status === 'failed') ? 'var(--danger)' : undefined }"></div></div>
            <div class="muted" style="display:flex;align-items:center;gap:8px;margin-top:4px;white-space:nowrap;font-size:12px">
              <span v-if="busy" class="spin"></span><b>{{ showPct }}%</b><span v-if="elapsedText">{{ elapsedText }}</span><span class="ellip" :title="progressText">{{ progressText }}</span>
            </div>
          </div>
          <button class="btn primary" :disabled="busy" @click="go">{{ busy ? '生成中' : '开始生成' }}</button>
          <button v-if="busy" class="btn danger" @click="stopJob" title="停止当前任务（排队中的直接出队，执行中的安全打断）">停止</button>
        </div>
      </div>
      <div v-if="job && job.error" class="alert err" style="margin-bottom:12px">{{ job.error }}</div>

      <div class="card">
        <h3 style="margin:0 0 12px">功能控制框</h3>
        <div class="row" style="align-items:center;margin-bottom:12px">
          <label class="chk" style="margin:0"><input type="checkbox" v-model="p.layered" /> 生成 PSD 分层图（默认勾选；取消则按普通文生图出图）</label>
          <div class="field" style="width:120px;margin:0" v-if="p.layered"><label>图层数</label><input type="number" v-model.number="p.layers" min="2" max="8" /></div>
        </div>
        <div class="grid-2">
          <div class="field"><label>正向提示词（必填，已内置 PSD 分层引导）</label><textarea v-model="p.prompt" style="min-height:140px"></textarea></div>
          <div class="field"><label>负向提示词</label>
            <div style="display:flex;gap:6px;margin-bottom:6px">
              <button class="btn sm" type="button" @click="addNeg('person')" title="追加人物负面词（防双人体/畸形手/水印等）">人物负面词</button>
              <button class="btn sm" type="button" @click="addNeg('ad')" title="追加分层图负面词（防水印/扭曲/杂乱等）">分层图负面词</button>
              <button class="btn sm" type="button" @click="clearNeg" title="清空负向提示词">清空</button>
            </div>
            <textarea v-model="p.negative" style="min-height:140px"></textarea></div>
        </div>
        <div class="row">
          <div class="field"><label>UNet（扩散模型）</label><input v-model="p.unet_name" /></div>
          <div class="field"><label>CLIP 文本编码器</label><input v-model="p.clip_name" /></div>
          <div class="field"><label>VAE</label><input v-model="p.vae_name" /></div>
        </div>
        <div class="row">
          <div class="field"><label>宽度（width）</label><input type="number" v-model.number="p.width" min="64" step="16" /></div>
          <div class="field"><label>高度（height）</label><input type="number" v-model.number="p.height" min="64" step="16" /></div>
          <div class="field" style="min-width:0;flex:none;display:flex;align-items:flex-end;padding-bottom:4px">
            <button class="btn sm" @click="swapSize" title="宽高互换（横竖版切换）">⇄ 互换</button>
          </div>
          <div class="field" style="min-width:0;flex:none;display:flex;align-items:flex-end;padding-bottom:4px">
            <label class="chk" style="display:flex;align-items:center;gap:6px;white-space:nowrap">尺寸
              <select v-model="sizePreset" @change="applyPreset">
                <option value="">常用尺寸</option>
                <option v-for="s in sizePresets" :key="s.v" :value="s.v">{{ s.label }}</option>
              </select>
            </label>
          </div>
          <div class="field" style="min-width:0;flex:none;display:flex;align-items:flex-end;padding-bottom:4px">
            <label class="chk" style="display:flex;align-items:center;gap:6px;white-space:nowrap">锁定比例
              <select v-model="ratioLock" @change="onRatioLock">
                <option value="">不锁定</option>
                <option value="16:9">16:9</option>
                <option value="4:3">4:3</option>
              </select>
            </label>
          </div>
          <div class="field"><label>采样移位（shift）</label><input type="number" v-model.number="p.shift" step="0.1" /></div>
          <div class="field"><label>种子（-1 随机）</label><input v-model="p.seed" /></div>
        </div>
        <div class="row">
          <div class="field"><label>步数（steps）</label><input type="number" v-model.number="p.steps" min="1" /></div>
          <div class="field"><label>CFG</label><input type="number" v-model.number="p.cfg" step="0.1" /></div>
          <div class="field"><label>采样器（sampler_name）</label><input v-model="p.sampler_name" /></div>
          <div class="field"><label>调度器（scheduler）</label><input v-model="p.scheduler" /></div>
          <div class="field"><label>降噪（denoise）</label><input type="number" v-model.number="p.denoise" step="0.01" /></div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3 style="margin:0 0 12px">工作流关联节点 <span class="muted" style="font-size:12px;font-weight:normal">（Qwen-Image-Layered 内置核心节点；模型与采样参数在上方功能控制框内直接调整）</span></h3>
        <table class="tbl">
          <thead><tr><th>#</th><th>节点类型</th><th>作用</th><th>关键输入</th></tr></thead>
          <tbody>
            <tr v-for="n in nodeList" :key="n.id"><td class="mono">{{ n.id }}</td><td class="mono">{{ n.type }}</td><td>{{ n.role }}</td><td class="mono" style="font-size:12px">{{ n.inputs }}</td></tr>
          </tbody>
        </table>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>最近生成图
          <button class="btn sm" style="margin-left:10px" @click="openFolder">打开文件夹</button>
          <span class="muted" style="margin-left:10px">共 {{ doneImages.length }} 张</span>
        </h3>
        <div v-if="!doneImages.length" class="muted">暂无已完成的图片</div>
        <div v-else class="img-strip">
          <div v-for="im in doneImages" :key="im.id" class="img-strip-card" :title="im.prompt || ''">
            <img :src="imgUrl(im)" style="cursor:zoom-in" @click="zoomImg(im)" />
            <div class="vmeta">
              <span class="muted">#{{ im.id }}</span>
              <a class="btn sm" :href="imgUrl(im)" download>下载图</a>
              <a v-if="im.psd_path" class="btn sm" :href="authed('/api/image/psd/' + im.id)">下载 PSD</a>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>任务队列详情</h3>
        <div v-if="!queue.length" class="muted">队列为空</div>
        <table v-else class="tbl">
          <thead><tr><th>序号</th><th>提示词</th><th>尺寸</th><th>状态</th><th>过程</th><th>耗时</th><th>模型</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="q in queuePage" :key="q.id">
              <td>{{ q.id }}</td>
              <td class="ellip" :title="q.prompt">{{ q.prompt || '-' }}</td>
              <td>{{ sizeOf(q) }}</td>
              <td>{{ statusLabel(q.status) }}</td>
              <td class="ellip">{{ q.progress || '-' }}</td>
              <td class="muted">{{ fmtDur(q.duration_ms) }}</td>
              <td class="ellip" :title="modelOf(q)">{{ modelOf(q) }}</td>
              <td style="white-space:nowrap">
                <button class="btn sm" @click="regen(q)" title="把该任务的参数还原到上方参数框（不自动生成）">再生成</button>
                <a v-if="q.image_path" class="btn sm" :href="authed('/api/image/output/' + basename(q.image_path))" download>下载图</a>
                <a v-if="q.psd_path" class="btn sm" :href="authed('/api/image/psd/' + q.id)">下载 PSD</a>
                <a class="btn sm" :href="authed('/api/image/workflow/' + q.id)">工作流</a>
                <span v-if="q.status==='failed'" style="color:var(--danger)">{{ q.error }}</span>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="queue.length > qPageSize || qPage > 0" class="row" style="flex:none;justify-content:flex-end;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap">
          <span class="muted">共 {{ queue.length }} 条</span>
          <select v-model.number="qPageSize" @change="qPage = 0" style="width:auto">
            <option>10</option><option>20</option><option>30</option><option>50</option><option>100</option>
          </select>
          <span class="muted">条/页</span>
          <button class="btn sm" :disabled="qPage <= 0" @click="qPage--">‹ 上一页</button>
          <span class="muted">{{ qPage + 1 }} / {{ qTotalPages }}</span>
          <button class="btn sm" :disabled="(qPage + 1) * qPageSize >= queue.length" @click="qPage++">下一页 ›</button>
        </div>
      </div>
    </div>`,
    data() {
      return {
        p: { prompt: '', negative: '', clip_name: '', clip_type: 'qwen_image', clip_device: 'default', vae_name: '', unet_name: '', weight_dtype: 'default', width: 2560, height: 1440, layers: 3, shift: 1.0, seed: -1, steps: 20, cfg: 2.5, sampler_name: 'euler', scheduler: 'simple', denoise: 1.0, layered: true },
        busy: false, statusText: '', job: null, timer: null,
        queue: [], qTimer: null, pctHigh: 0, qPage: 0, qPageSize: 10, ratioLock: '', ratio: 0, _syncing: false, sizePreset: '2560x1440', sizePresets: SIZE_PRESETS,
        nodeList: [
          { id: 1, type: 'UNETLoader', role: '加载扩散模型', inputs: 'unet_name · weight_dtype' },
          { id: 2, type: 'CLIPLoader', role: '加载文本编码器', inputs: 'clip_name · type=qwen_image' },
          { id: 3, type: 'VAELoader', role: '加载 VAE', inputs: 'vae_name' },
          { id: 4, type: 'CLIPTextEncode', role: '正向提示词编码', inputs: 'text' },
          { id: 5, type: 'CLIPTextEncode', role: '负向提示词编码', inputs: 'text' },
          { id: 6, type: 'EmptyQwenImageLayeredLatentImage', role: '分层潜空间（5D）', inputs: 'width · height · layers · batch_size' },
          { id: 7, type: 'ModelSamplingAuraFlow', role: 'AuraFlow 采样', inputs: 'shift' },
          { id: 8, type: 'KSampler', role: '扩散采样', inputs: 'seed · steps · cfg · sampler · scheduler · denoise' },
          { id: 9, type: 'LatentCut', role: '切掉合并层（index=1）', inputs: 'dim=t · index=1 · amount' },
          { id: 10, type: 'LatentCutToBatch', role: '图层维转 batch', inputs: 'dim=t · slice_size=1' },
          { id: 11, type: 'VAEDecode', role: '逐层解码 RGBA', inputs: 'samples · vae' },
          { id: 12, type: 'SaveImage', role: '保存图层 PNG', inputs: 'filename_prefix' },
          { id: 13, type: 'LatentCut', role: '取合并层（index=0）', inputs: 'dim=t · index=0' },
          { id: 14, type: 'LatentCutToBatch', role: '合并层转 batch', inputs: 'dim=t · slice_size=1' },
          { id: 15, type: 'VAEDecode', role: '解码合并预览', inputs: 'samples · vae' },
          { id: 16, type: 'SaveImage', role: '保存预览 PNG', inputs: 'filename_prefix' },
        ],
      };
    },
    computed: {
      doneImages() { return (this.queue || []).filter((q) => q.status === 'done' && q.image_path); },
      qTotalPages() { return Math.max(1, Math.ceil((this.queue || []).length / this.qPageSize)); },
      queuePage() { return (this.queue || []).slice(this.qPage * this.qPageSize, (this.qPage + 1) * this.qPageSize); },
      jobProgressPct() {
        if (!this.job) return 0;
        if (this.job.status === 'done' || this.job.status === 'failed') return 100;
        const p = Number(this.job.progress_pct);
        return Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
      },
      showPct() { return Math.max(this.pctHigh, this.jobProgressPct); },
      progressText() {
        if (this.job && this.job.progress) return this.job.progress;
        if (this.job && this.job.status === 'failed') return '生成失败';
        return this.statusText || '准备中…';
      },
    },
    watch: {
      // 锁定比例（与文生图同款）：flush:'sync' 防互踢回声，输入一边保持输入值只改另一边
      'p.width': { flush: 'sync', handler(v) { if (this._syncing) return; this.sizePreset = ''; /* 手动输入即脱离尺寸预设 */ if (this.ratioLock && this.ratio && Number(v) > 0) { this._syncing = true; this.p.height = Math.round(Number(v) / this.ratio); this._syncing = false; } } },
      'p.height': { flush: 'sync', handler(v) { if (this._syncing) return; this.sizePreset = ''; if (this.ratioLock && this.ratio && Number(v) > 0) { this._syncing = true; this.p.width = Math.round(Number(v) * this.ratio); this._syncing = false; } } },
    },
    async mounted() {
      this.loadDefaults();
      this.refreshQueue();
      this.qTimer = setInterval(() => this.refreshQueue(), 3000);
    },
    methods: {
      authed, basename,
      sizeOf(q) { try { const p = JSON.parse(q.params || '{}'); return p.width && p.height ? p.width + '×' + p.height : '-'; } catch { return '-'; } },
      async loadDefaults() {
        try {
          const d = await api('GET', '/image/qil-defaults');
          for (const k of Object.keys(this.p)) { if (k !== 'layered' && d[k] !== undefined) this.p[k] = d[k]; }
          // 默认尺寸恰为 16:9 / 4:3 时自动选中对应锁定（与文生图一致）
          if (Number(this.p.width) > 0 && Number(this.p.height) > 0) {
            const r = this.p.width / this.p.height;
            this.ratioLock = Math.abs(r - 16 / 9) < 0.02 ? '16:9' : Math.abs(r - 4 / 3) < 0.02 ? '4:3' : '';
            this.ratio = this.ratioLock === '16:9' ? 16 / 9 : this.ratioLock === '4:3' ? 4 / 3 : 0;
            this.sizePreset = matchPreset(this.p.width, this.p.height);
          }
        } catch (e) { /* 后端不可达时保留默认值 */ }
      },
      onRatioLock() {
        // 选定比例后立即生效：以已输入的一边为准算出另一边（两边都有值时以宽为准）
        this.ratio = this.ratioLock === '16:9' ? 16 / 9 : this.ratioLock === '4:3' ? 4 / 3 : 0;
        if (!this.ratio) return;
        if (Number(this.p.width) > 0) { this._syncing = true; this.p.height = Math.round(this.p.width / this.ratio); this._syncing = false; }
        else if (Number(this.p.height) > 0) { this._syncing = true; this.p.width = Math.round(this.p.height * this.ratio); this._syncing = false; }
      },
      swapSize() {
        // 宽高互换（横竖版切换）：互换后按新比例重新识别锁定预设（9:16/3:4 不在预设内→不锁定）
        const w = Number(this.p.width) || 0, h = Number(this.p.height) || 0;
        if (!w || !h) return;
        this._syncing = true; this.p.width = h; this.p.height = w; this._syncing = false;
        const r = h / w;
        this.ratioLock = Math.abs(r - 16 / 9) < 0.02 ? '16:9' : Math.abs(r - 4 / 3) < 0.02 ? '4:3' : '';
        this.ratio = this.ratioLock === '16:9' ? 16 / 9 : this.ratioLock === '4:3' ? 4 / 3 : 0;
        this.sizePreset = matchPreset(this.p.width, this.p.height);
      },
      applyPreset() {
        // v1.0.35 尺寸下拉：选中即写入宽高并重识别锁定（16:10、21:9 不在锁定预设内→不锁定）
        if (!this.sizePreset) return;
        const [w, h] = this.sizePreset.split('x').map(Number);
        this._syncing = true; this.p.width = w; this.p.height = h; this._syncing = false;
        const r = w / h;
        this.ratioLock = Math.abs(r - 16 / 9) < 0.02 ? '16:9' : Math.abs(r - 4 / 3) < 0.02 ? '4:3' : '';
        this.ratio = this.ratioLock === '16:9' ? 16 / 9 : this.ratioLock === '4:3' ? 4 / 3 : 0;
      },
      regen(q) {
        // 再生成：把该任务落库的参数整体还原进上方参数框，等用户自己点「开始生成」（不自动提交）
        let pp = {};
        try { pp = JSON.parse(q.params || '{}'); } catch (e) { alert('该任务参数无法解析'); return; }
        this._syncing = true; // 整体写回：不让宽高互锁中途重算
        for (const k of Object.keys(this.p)) if (pp[k] !== undefined) this.p[k] = pp[k];
        this._syncing = false;
        this.p.prompt = String(q.prompt || '');         // v1.0.38 报障修复：提示词/负向在独立列不在 params，此前漏还原
        this.p.negative = String(q.negative_prompt || '');
        const w = Number(this.p.width) || 0, h = Number(this.p.height) || 0;
        if (w > 0 && h > 0) {
          const r = w / h;
          this.ratioLock = Math.abs(r - 16 / 9) < 0.02 ? '16:9' : Math.abs(r - 4 / 3) < 0.02 ? '4:3' : '';
          this.ratio = this.ratioLock === '16:9' ? 16 / 9 : this.ratioLock === '4:3' ? 4 / 3 : 0;
        }
        this.sizePreset = matchPreset(w, h); // 恰好等于某预设时下拉同步选中
        this.statusText = '已还原任务 #' + q.id + ' 的参数，确认后点「开始生成」' + (this.p.gen_mode && this.p.gen_mode !== 't2i' ? '（放大模式需重新选择原图）' : '');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
      statusLabel(s) { return { pending: '排队中', running: '生成中', done: '完成', failed: '失败' }[s] || s; },
      fmtDur(ms) {
        if (!ms || ms <= 0) return '-';
        if (ms < 1000) return ms + 'ms';
        if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
        const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
        return m + 'm' + (s ? s + 's' : '');
      },
      imgUrl(q) { return authed('/api/image/output/' + basename(q.image_path)); },
      modelOf(q) {
        try { const pr = JSON.parse(q.params || '{}'); return basename(pr.unet_name || pr.clip_name || ''); } catch { return '-'; }
      },
      async refreshQueue() {
        try {
          const d = await api('GET', '/image/queue?source=ad'); this.queue = d.jobs || [];
          if (this.qPage >= this.qTotalPages) this.qPage = this.qTotalPages - 1; // 队列缩短时收拢页码
          if (!this.busy) {
            const run = (this.queue || []).find((q) => (q.status === 'running' || q.status === 'pending') && q.user_id === store.user.id);
            if (run) {
              this.busy = true; this.statusText = run.status === 'pending' ? '排队中…' : '生成中…';
              this.startClock(Date.parse(String(run.created_at || '').replace(' ', 'T')) || undefined);
              this.poll(run.id);
            }
          }
        } catch (e) {}
      },
      async openFolder() { try { await api('POST', '/image/open-output-dir'); } catch (e) { alert(e.message); } },
      // v1.0.41 负向提示词快捷键：追加人物/广告图词组（可叠加、重复添加拦截）、一键清空
      addNeg(kind) {
        const list = kind === 'person' ? NEG_PRESETS.person : NEG_PRESETS.ad;
        const cur = String(this.p.negative || '').trim();
        if (cur.includes(list)) return;
        this.p.negative = cur ? cur.replace(/[，,]\s*$/, '') + '，' + list : list;
      },
      clearNeg() { this.p.negative = ''; },
      async go() {
        if (!this.p.prompt.trim()) { alert('请输入正向提示词'); return; }
        this.busy = true; this.job = null; this.statusText = '提交中…'; this.pctHigh = 0; this.startClock();
        try {
          const body = {
            prompt: this.p.prompt, negative_prompt: this.p.negative,
            clip_name: this.p.clip_name, clip_type: this.p.clip_type, clip_device: this.p.clip_device,
            vae_name: this.p.vae_name, unet_name: this.p.unet_name, weight_dtype: this.p.weight_dtype,
            width: this.p.width, height: this.p.height, shift: this.p.shift,
            seed: this.p.seed, steps: this.p.steps, cfg: this.p.cfg,
            sampler_name: this.p.sampler_name, scheduler: this.p.scheduler, denoise: this.p.denoise,
            layered: !!this.p.layered, layers: this.p.layers,
            source: 'ad',
          };
          const _busy = await busyBefore();
          const d = await api('POST', '/image/generate', body);
          this.poll(d.id); this.refreshQueue(); queueBusyNotice(_busy);
        } catch (e) { alert(e.message); this.statusText = ''; this.busy = false; this.stopClock(); }
      },
      poll(id) {
        this.timer = setInterval(async () => {
          try {
            const d = await api('GET', '/image/job/' + id);
            this.job = d.job;
            const p = Number(d.job.progress_pct);
            if (Number.isFinite(p)) this.pctHigh = Math.max(this.pctHigh, Math.min(100, p));
            if (d.job.status === 'done') { this.statusText = '完成'; this.busy = false; this.stopClock(); clearInterval(this.timer); this.refreshQueue(); }
            else if (d.job.status === 'failed') { this.statusText = '失败'; this.busy = false; this.stopClock(); clearInterval(this.timer); this.refreshQueue(); }
            else this.statusText = d.job.progress || (d.job.status === 'pending' ? '排队中…' : '生成中…');
          } catch (e) { clearInterval(this.timer); this.busy = false; this.stopClock(); this.statusText = ''; }
        }, 3000);
      },
      async stopJob() {
        if (!this.job || !this.job.id) { alert('任务刚提交、还没登记好，1-2 秒后再点停止'); return; }
        try { await api('POST', '/tasks/zimage/' + this.job.id + '/stop'); this.statusText = '停止中…'; }
        catch (e) { alert(e.message); }
      },
      zoomImg(im) {
        const items = this.doneImages.map((q) => ({ kind: 'image', url: this.imgUrl(q), title: q.prompt || '', sub: '#' + q.id + ' · ' + (q.created_at || '') }));
        openViewer(items, this.doneImages.indexOf(im));
      },
    },
    beforeUnmount() { if (this.timer) clearInterval(this.timer); if (this.qTimer) clearInterval(this.qTimer); },
  };

  // ---------- 视频生成（MiniMax-H3：图生视频 / 文生视频） ----------
  // 需求33 生视频H3 常用尺寸：文生图H3 现有预设全量 + 480P/360P 两个视频档（引擎 latent 按 //16 对齐，854/360 照填即可）
  const H3V_SIZE_PRESETS = SIZE_PRESETS.concat([
    { v: '854x480', label: '854×480（480P）' },
    { v: '640x360', label: '640×360（360P）' },
  ]);
  const matchH3VPreset = (w, h) => { const k = Number(w) + 'x' + Number(h); return H3V_SIZE_PRESETS.some((s) => s.v === k) ? k : ''; };

  const H3 = {
    template: `
    <div>
      <div class="page-head" style="display:flex;align-items:flex-start;justify-content:space-between;gap:16px">
        <div style="min-width:0"><h2>生视频H3</h2><div class="desc">MiniMax-H3 多镜采样：图生视频（首帧 / 首尾帧）/ 文生视频 / 人物参考图（ref2va），统一 8189 后端</div></div>
        <div style="flex:none;display:flex;align-items:center;gap:12px">
          <div v-if="job || statusText" style="width:320px;max-width:38vw">
            <div class="progress"><div :style="{ width: showPct + '%', background: (job && job.status === 'failed') ? 'var(--danger)' : undefined }"></div></div>
            <div class="muted" style="display:flex;align-items:center;gap:8px;margin-top:4px;white-space:nowrap;font-size:12px">
              <span v-if="busy" class="spin"></span><b>{{ showPct }}%</b><span v-if="elapsedText">{{ elapsedText }}</span><span class="ellip" :title="progressText">{{ progressText }}</span>
            </div>
          </div>
          <button class="btn primary" :disabled="busy" @click="go">{{ busy ? '生成中' : '开始生成' }}</button>
          <button class="btn" :disabled="busy || batchBusy" @click="openBatch" title="粘贴多段提示词（每段以「## 图1」标题行分隔），一键批量提交多个视频任务排队执行">批量生成</button>
          <button v-if="busy" class="btn danger" @click="stopJob" title="停止当前任务（排队中的直接出队，执行中的安全打断）">停止</button>
        </div>
      </div>
      <div v-if="job && job.error" class="alert err" style="margin-bottom:12px">{{ job.error }}</div>

      <div class="card">
        <div class="row" style="flex:none;align-items:center;margin-bottom:12px">
          <h3 style="margin:0">模式
            <span class="badge" :class="h3Status.running ? 'ok' : 'err'" style="margin-left:10px">{{ h3Status.running ? 'H3 后端在线' : 'H3 后端离线' }}</span>
            <span class="muted" v-if="h3Status.device" style="margin-left:8px">{{ h3Status.device }}</span>
          </h3>
        </div>
        <div class="row" style="flex:none;margin-bottom:12px">
          <label><input type="radio" value="i2v" v-model="mode" /> 图生视频（上传首帧参考图）</label>
          <label><input type="radio" value="t2v" v-model="mode" /> 文生视频（纯提示词）</label>
        </div>
        <div v-if="mode==='i2v'" class="row" style="flex:none;align-items:flex-start;gap:24px;flex-wrap:wrap">
          <div class="field" style="max-width:420px">
            <label>首帧参考图 <span class="muted" style="font-weight:normal">（必传）</span></label>
            <input type="file" accept="image/*" @change="onFile($event, 'first')" />
            <img v-if="preview" :src="preview" class="preview-img" style="margin-top:10px;max-height:220px" />
            <div style="margin-top:8px">
              <button class="btn sm" @click="openPick('first')" title="从文生图/分层图的历史生成图中选一张当首帧">从系统选图</button>
              <button class="btn sm" style="margin-left:8px" @click="openPaste('first')" title="粘贴剪贴板图片（Ctrl+V）作为首帧参考图">粘贴图片</button>
              <button v-if="image" class="btn sm" style="margin-left:8px" @click="clearStart">清除首帧</button>
            </div>
          </div>
          <div class="field" style="max-width:420px">
            <label>尾帧参考图 <span class="muted" style="font-weight:normal">（可选；与首帧一起 = 首尾帧模式）</span></label>
            <input type="file" accept="image/*" @change="onFile($event, 'end')" />
            <img v-if="preview2" :src="preview2" class="preview-img" style="margin-top:10px;max-height:220px" />
            <div style="margin-top:8px">
              <button class="btn sm" @click="openPick('end')" title="从文生图/分层图的历史生成图中选一张当尾帧">从系统选图</button>
              <button class="btn sm" style="margin-left:8px" @click="openPaste('end')" title="粘贴剪贴板图片（Ctrl+V）作为尾帧参考图">粘贴图片</button>
              <button v-if="image2" class="btn sm" style="margin-left:8px" @click="clearEnd">清除尾帧</button>
            </div>
          </div>
        </div>
        <div v-if="mode==='i2v'" class="muted" style="margin-top:8px">
          当前模式：<b>{{ image2 ? '首尾帧（首帧 → 尾帧过渡，H3Keyframes 官方配方，固定 res_multistep/simple 采样，镜头数/采样器/调度器不生效）' : '单图（图生视频）' }}</b>；只传首帧 = 单图生成，再传尾帧 = 自动切换首尾帧模式，清除尾帧即回到单图。首尾两图建议同分辨率同构图，差异过大容易过渡崩坏。
        </div>
      </div>

      <!-- v1.0.55 人物参考图：ref2va 参考行，只定「这人是谁」不定构图；文生/图生视频都可用；与尾帧（首尾帧模式）互斥 -->
      <div class="card">
        <h3>人物参考图 <span class="muted" style="font-weight:normal;font-size:12px">（可选；最多 3 张同一人物，传了自动切 ref2va 模型并在提示词绑定 &lt;Picture N&gt;）</span></h3>
        <div class="row" style="flex-wrap:wrap;align-items:flex-start;gap:10px">
          <div v-for="(r, i) in refs" :key="i" style="position:relative;border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:4px">
            <img :src="r.dataUrl" style="height:96px;max-width:160px;object-fit:contain;border-radius:4px;display:block" />
            <button class="btn sm" style="position:absolute;top:-8px;right:-8px;padding:0 7px" title="移除这张" @click="removeRef(i)">×</button>
            <div style="font-size:11px;opacity:.65;text-align:center;margin-top:2px">第 {{ i + 1 }}/{{ refs.length }} 张</div>
          </div>
          <div v-if="refs.length < 3" style="display:flex;flex-direction:column;gap:8px">
            <input type="file" accept="image/*" multiple @change="onRefFile($event)" title="选择人物照片（可多选，追加进参考位）" />
            <div>
              <button class="btn sm" @click="openPick('ref')" title="从文生图/分层图的历史生成图中选一张当人物参考">从系统选图</button>
              <button class="btn sm" style="margin-left:8px" @click="openPaste('ref')" title="粘贴剪贴板图片（Ctrl+V），可连续粘贴多张追加">粘贴图片</button>
            </div>
          </div>
        </div>
        <div v-if="refs.length" style="margin-top:8px"><button class="btn sm" @click="clearRefs">清空参考（{{ refs.length }} 张）</button></div>
        <div class="muted" style="margin-top:8px;font-size:12px">
          参考图只决定人物长相/发型/穿着，不约束开场画面与运镜（区别于首帧）；与首帧可同时使用。参考能力是 ref2va 模型训练的：传参考会自动切 ref2va（未手动指定主模型时），不传则保持当前模型。<b>与尾帧互斥</b>：首尾帧双锚模式没有参考位，两边都设会自动清掉另一边。
        </div>
      </div>
      <!-- v1.0.43 从系统选图（视频生成首帧/尾帧；文生图+广告图最近完成的生成图） -->
      <div v-if="pickOpen" class="overlay" @click.self="pickOpen = false">
        <div class="card" style="max-width:880px;width:94vw;max-height:82vh;overflow:auto">
          <h3 style="margin:0 0 10px">从系统选图（{{ pickTitleText }}）</h3>
          <div v-if="pickBusy" style="padding:24px;text-align:center;opacity:.7">加载中…</div>
          <div v-else-if="!pickList.length" style="padding:24px;text-align:center;opacity:.7">还没有已完成的生成图</div>
          <div v-else style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px">
            <div v-for="it in pickList" :key="it.id" title="点选此图" style="cursor:pointer;border:1px solid rgba(128,128,128,.35);border-radius:8px;padding:6px;text-align:center" @click="pickOne(it)">
              <img :src="it.url" style="width:100%;height:92px;object-fit:cover;border-radius:4px" />
              <div style="font-size:12px;margin-top:4px">{{ it.src }} {{ it.wh }}<span v-if="it.mode"> · {{ it.mode }}</span></div>
              <div style="font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">{{ it.prompt || it.file }}</div>
            </div>
          </div>
          <div style="margin-top:12px;text-align:right"><button class="btn sm" @click="pickOpen = false">取消</button></div>
        </div>
      </div>

      <!-- 需求28 粘贴图片：首帧/尾帧参考图；v1.0.55 人物参考图可多张追加 -->
      <PasteDlg v-if="pasteOpen" :title="pasteTitle" :multi="pasteTarget === 'ref'" @confirm="onPasteConfirm" @close="pasteOpen = false" />

      <!-- 需求30 批量生成：粘贴「## 图N」分段提示词，一键提交多个生视频H3 任务（对齐文生图Z/文生图H3） -->
      <div v-if="batchOpen" class="overlay" @click.self="closeBatch">
        <div class="card" style="max-width:860px;width:94vw;max-height:86vh;overflow:auto">
          <h3 style="margin:0 0 10px">批量生成（生视频H3）</h3>
          <div class="muted" style="margin-bottom:8px;font-size:12px">粘贴多段提示词，每段前面加一行以分割关键词开头的标题（默认「## 图1」「## 图2」…）。每段提交为一个独立视频任务，共用当前参数区的尺寸 / 帧数 / 步数等设置；图生视频模式下首帧与尾帧也共用当前已选（含首尾帧模式）。视频生成耗时长，任务按顺序自动排队执行。</div>
          <div class="row" style="align-items:center;margin-bottom:8px;flex-wrap:wrap">
            <label style="flex:none;font-size:13px;font-weight:600">分割关键词</label>
            <input v-model="batchSep" style="width:170px" placeholder="## 图" title="以该关键词开头的行视为一段的标题行" />
            <span class="muted" style="flex:1;min-width:220px;font-size:12px">以该关键词开头的行 = 新一段的开始；留空用默认「## 图」</span>
          </div>
          <textarea v-model="batchText" style="width:100%;min-height:300px;font-size:13px" placeholder="## 图1&#10;镜头一：…&#10;&#10;## 图2&#10;镜头二：…"></textarea>
          <div v-if="batchText.trim()" class="row" style="align-items:center;margin-top:8px;flex-wrap:wrap">
            <b style="flex:none">解析出 {{ batchList.length }} 个任务</b>
            <span v-if="!batchList.length" class="alert err" style="margin:0;flex:1">没识别到分段：每段提示词前需要一行以分割关键词开头的标题行（当前「{{ batchSep || '## 图' }}」）</span>
            <span v-else class="muted ellip" style="flex:1;font-size:12px" :title="batchList.map(t=>t.title).join(' / ')">{{ batchList.map(t=>t.title).join(' / ') }}</span>
          </div>
          <div style="margin-top:12px;text-align:right">
            <button class="btn sm" :disabled="batchBusy" @click="closeBatch">取消</button>
            <button class="btn sm primary" style="margin-left:8px" :disabled="batchBusy || !batchList.length" @click="submitBatch">{{ batchBusy ? '提交中 ' + batchDone + '/' + batchList.length + '…' : '一键提交 ' + batchList.length + ' 个任务' }}</button>
          </div>
        </div>
      </div>

      <div class="card">
        <h3>提示词（可拖拽右下角调节大小）</h3>
        <textarea v-model="p.prompt" class="big-textarea" style="width:100%"></textarea>
      </div>

      <div class="card">
        <h3>功能控制框</h3>
        <div class="row">
          <div class="field"><label>主模型（model_name）</label><input v-model="p.model_name" placeholder="留空 = 自动：无参考 fl2va · 带参考 ref2va" title="留空时自动选：无人物参考用 fl2va，带参考自动切 ref2va；手动填了就以你为准" /></div>
          <div class="field"><label>文本编码器（clip_name）</label><input v-model="p.clip_name" /></div>
          <div class="field"><label>CLIP 类型（clip_type）</label><input v-model="p.clip_type" /></div>
        </div>
        <div class="row">
          <div class="field"><label>mmproj（mmproj_name）</label><input v-model="p.mmproj_name" /></div>
          <div class="field"><label>视频 VAE（video_vae）</label><input v-model="p.video_vae" /></div>
          <div class="field"><label>音频 VAE（audio_vae）</label><input v-model="p.audio_vae" /></div>
        </div>
        <div class="row">
          <div class="field"><label>镜头数（shot_count）</label><input type="number" v-model.number="p.shot_count" min="0" max="8" /></div>
          <div class="field"><label>宽（width）</label><input type="number" v-model.number="p.width" min="32" /></div>
          <div class="field"><label>高（height）</label><input type="number" v-model.number="p.height" min="32" /></div>
          <div class="field" style="min-width:0;flex:none;display:flex;align-items:flex-end;padding-bottom:4px">
            <button class="btn sm" @click="swapSize" title="宽高互换（横竖版切换）">⇄ 互换</button>
          </div>
          <div class="field"><label>常用尺寸</label>
            <select v-model="sizePreset" @change="applyPreset"><option value="">— 手动输入 —</option><option v-for="s in sizePresets" :key="s.v" :value="s.v">{{ s.label }}</option></select>
          </div>
          <div class="field">
            <label>每镜头帧数（frames_per_shot）≈ {{ framesSecHint }}</label>
            <div class="row" style="flex-wrap:nowrap;gap:8px">
              <input type="number" v-model.number="p.frames_per_shot" min="5" max="481" style="flex:1;min-width:0" />
              <input type="number" v-model.number="shotSec" @input="secToFrames" min="0.1" step="0.1" placeholder="按秒填…" title="填秒数，按当前帧率自动换算并回填帧数" style="flex:1;min-width:0" />
            </div>
            <div class="muted" style="font-size:12px;margin-top:4px">右侧填秒数：按 {{ p.fps }} fps 自动换算回填帧数（当前 ≈ {{ framesSecHint }}）</div>
          </div>
        </div>
        <div class="row">
          <div class="field"><label>种子（-1 随机）</label><input v-model="p.seed" /></div>
          <div class="field"><label>步数（steps）</label><input type="number" v-model.number="p.steps" min="1" max="50" /></div>
          <div class="field"><label>采样器（sampler_name）</label><input v-model="p.sampler_name" /></div>
          <div class="field"><label>调度器（scheduler）</label><input v-model="p.scheduler" /></div>
        </div>
        <div class="row">
          <div class="field"><label>输出缩放（output_scale）</label><input type="number" v-model.number="p.output_scale" step="0.1" /></div>
          <div class="field"><label>帧率（fps）</label><input type="number" v-model.number="p.fps" min="1" /></div>
          <div class="field"><label>位深（bit_depth）</label>
            <select v-model="p.bit_depth"><option>auto</option><option>8</option><option>10</option><option>16</option></select>
          </div>
          <div class="field"><label>色彩空间（color_space）</label>
            <select v-model="p.color_space"><option>sRGB</option><option>DisplayP3</option><option>rec709</option></select>
          </div>
        </div>
        <div class="row" style="flex:none">
          <label class="chk"><input type="checkbox" v-model="p.seed_per_shot" /> 每镜头独立种子（seed_per_shot）</label>
          <label class="chk"><input type="checkbox" v-model="p.self_anchor_voice" /> 自锚定音频（self_anchor_voice）</label>
        </div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>最近视频
          <button class="btn sm" style="margin-left:10px" @click="openFolder">打开文件夹</button>
          <span class="muted" style="margin-left:10px">共 {{ doneVideos.length }} 个</span>
          <button class="btn sm" style="margin-left:10px" :disabled="stripPage<=0" @click="stripPage--">‹</button>
          <button class="btn sm" :disabled="(stripPage+1)*stripSize>=doneVideos.length" @click="stripPage++">›</button>
        </h3>
        <div v-if="!doneVideos.length" class="muted">暂无已完成的视频</div>
        <div v-else class="img-strip">
          <div v-for="v in stripSlice" :key="v.id" class="img-strip-card peek" :title="(v.prompt || '') + '\\n点击打开，← → 前后翻页'" @click="openVid(v)">
            <video :src="vidUrl(v)" preload="metadata"></video>
            <div class="vmeta"><span class="muted">#{{ v.id }}</span><a class="btn sm" :href="vidUrl(v)" download @click.stop>下载</a></div>
          </div>
        </div>
        <div v-if="doneVideos.length > stripSize" class="muted" style="margin-top:6px">点视频可打开查看，← → 翻看全部 {{ doneVideos.length }} 个</div>
      </div>

      <div class="card" style="margin-top:16px">
        <h3>任务队列详情</h3>
        <div v-if="!queue.length" class="muted">队列为空</div>
        <table v-else class="tbl">
          <thead><tr><th>序号</th><th>提示词</th><th>尺寸</th><th>状态</th><th>过程</th><th>耗时</th><th>使用模型</th><th>结果</th></tr></thead>
          <tbody>
            <tr v-for="q in queue" :key="q.id">
              <td>{{ q.id }}</td>
              <td class="ellip" :title="q.prompt">{{ q.prompt || '-' }}</td>
              <td style="white-space:nowrap">{{ whOf(q) }}</td>
              <td>{{ statusLabel(q.status) }}</td>
              <td class="ellip">{{ q.progress || '-' }}</td>
              <td class="muted">{{ fmtDur(q.duration_ms) }}</td>
              <td class="ellip" :title="modelOf(q)">{{ modelOf(q) }}</td>
              <td style="white-space:nowrap">
                <a v-if="q.video_path" class="btn sm" :href="authed('/api/h3/output/' + basename(q.video_path))" download>下载</a>
                <a class="btn sm" :href="authed('/api/h3/workflow/' + q.id)">工作流</a>
                <button class="btn sm" @click="regen(q)" title="把该任务的提示词与全部参数还原到上方（不自动生成）">再生成</button>
                <span v-if="q.status==='failed'" style="color:var(--danger)">{{ q.error }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>`,
    data() {
      return {
        mode: 'i2v',
        preview: '', image: '', image_ext: 'png',
        preview2: '', image2: '', image2_ext: 'png', // v1.0.48 需求29：尾帧参考图（与首帧一起 = 首尾帧模式）
        refs: [], // v1.0.55 人物参考图（≤3 张 {dataUrl, ext}，ref2va 参考行；与尾帧互斥）
        pickOpen: false, pickBusy: false, pickList: [], pickTarget: 'first', // v1.0.43 从系统选图（首帧/尾帧参考图）
        pasteOpen: false, pasteTarget: 'first', pasteTitle: '', // 需求28 粘贴图片（首帧/尾帧参考图）
        p: { prompt: '', model_name: '', clip_name: '', clip_type: 'minimax', mmproj_name: '(auto)', video_vae: '', audio_vae: '', shot_count: 1, width: 480, height: 854, frames_per_shot: 362, seed: 20260722, steps: 20, seed_per_shot: true, sampler_name: 'euler', scheduler: 'beta', self_anchor_voice: false, output_scale: 1, fps: 24, bit_depth: 'auto', color_space: 'sRGB' },
        sizePreset: '', sizePresets: H3V_SIZE_PRESETS, // 需求33 常用尺寸 + 互换（对齐文生图H3；默认 480×854 不在预设内 → 下拉显示「手动输入」）
        h3Status: { running: false, url: '', device: '' },
        batchOpen: false, batchText: '', batchBusy: false, batchDone: 0, batchSep: '## 图', // 需求30 批量生成（对齐文生图Z/文生图H3）
        busy: false, statusText: '', job: null, timer: null,
        queue: [], qTimer: null, stripPage: 0, stripSize: 10,
        pctHigh: 0, shotSec: '',
      };
    },
    computed: {
      doneVideos() { return (this.queue || []).filter((q) => q.status === 'done' && q.video_path); },
      // 需求30 批量生成解析（同文生图Z/文生图H3）：以 batchSep 开头的行 = 标题行
      batchList() {
        const sep = String(this.batchSep || '').trim() || '## 图';
        const lines = String(this.batchText || '').split(/\r?\n/);
        const out = []; let cur = null;
        for (const ln of lines) {
          if (ln.trim().startsWith(sep.trim())) {
            if (cur) out.push(cur);
            cur = { title: ln.trim().replace(/^#{1,6}\s+/, '').trim() || ('任务' + (out.length + 1)), text: '' };
          } else if (cur) cur.text += (cur.text ? '\n' : '') + ln;
        }
        if (cur) out.push(cur);
        return out.filter((t) => { t.text = t.text.trim(); return t.text; });
      },
      stripSlice() { const s = this.stripPage * this.stripSize; return this.doneVideos.slice(s, s + this.stripSize); },
      pickTitleText() { return { end: '作为尾帧参考图', ref: '追加为人物参考图' }[this.pickTarget] || '作为首帧参考图'; },
      // 每镜头时长提示（帧数 ÷ 帧率）；秒数框回填帧数见 secToFrames
      framesSecHint() { const f = Number(this.p.fps); return f > 0 ? (this.p.frames_per_shot / f).toFixed(1) + ' 秒' : ''; },
      jobProgressPct() {
        if (!this.job) return 0;
        if (this.job.status === 'done' || this.job.status === 'failed') return 100;
        const p = Number(this.job.progress_pct);
        return Number.isFinite(p) ? Math.max(0, Math.min(100, p)) : 0;
      },
      showPct() { return Math.max(this.pctHigh, this.jobProgressPct); },
      progressText() {
        if (this.job && this.job.progress) return this.job.progress;
        if (this.job && this.job.status === 'failed') return '生成失败';
        return this.statusText || '准备中…';
      },
    },
    async mounted() {
      this.loadDefaults();
      this.loadStatus();
      this.refreshQueue();
      this.qTimer = setInterval(() => this.refreshQueue(), 3000);
    },
    methods: {
      authed, basename,
      async loadDefaults() {
        try { const d = await api('GET', '/h3/defaults'); Object.assign(this.p, d); } catch (e) {}
        // v1.0.58：默认模型名不冒充手选（否则后端「参考图自动切 ref2va」被击穿，高级框显示也失真）
        if (this.p.model_name === 'MiniMax-H3-fl2va-curve-Q4_0.gguf') this.p.model_name = '';
        this.sizePreset = matchH3VPreset(this.p.width, this.p.height); // 需求33：默认恰为某预设时下拉同步选中
      },
      // 需求33：常用尺寸 / 宽高互换（对齐文生图H3 机制）
      applyPreset() {
        const v = this.sizePreset; if (!v) return;
        const [w, h] = v.split('x').map(Number);
        this.p.width = w; this.p.height = h;
      },
      swapSize() { const w = this.p.width; this.p.width = this.p.height; this.p.height = w; },
      async loadStatus() { try { this.h3Status = await api('GET', '/h3/status'); } catch (e) {} },
      onFile(e, which) {
        const f = e.target.files[0]; if (!f) return;
        const r = new FileReader();
        r.onload = () => {
          if (which === 'end') { this.setEnd(r.result, f.name.split('.').pop()); }
          else { this.preview = r.result; this.image = r.result; this.image_ext = f.name.split('.').pop(); }
        };
        r.readAsDataURL(f);
      },
      // v1.0.55：尾帧与人物参考图互斥（首尾帧双锚无参考位）——设尾帧清参考，加参考清尾帧，都出声提醒
      setEnd(dataUrl, ext) {
        this.preview2 = dataUrl; this.image2 = dataUrl; this.image2_ext = ext;
        if (this.refs.length) { this.refs = []; alert('已自动清空人物参考图：首尾帧（双锚点）模式没有参考位。清除尾帧后可重新添加参考。'); }
      },
      addRefs(list) {
        const room = 3 - this.refs.length;
        const add = (list || []).slice(0, Math.max(0, room));
        if (!add.length) { alert('人物参考图最多 3 张'); return; }
        if (this.image2) { this.preview2 = ''; this.image2 = ''; alert('已自动清除尾帧：人物参考图与首尾帧（双锚点）模式互斥。需要尾帧请先清空参考。'); }
        this.refs = this.refs.concat(add);
      },
      onRefFile(e) {
        const fs = [...(e.target.files || [])]; e.target.value = '';
        if (!fs.length) return;
        let pending = fs.length;
        const items = [];
        const done = () => { if (items.length) this.addRefs(items); };
        for (const f of fs) {
          const r = new FileReader();
          r.onload = () => { items.push({ dataUrl: r.result, ext: f.name.split('.').pop() }); if (--pending <= 0) done(); };
          r.readAsDataURL(f);
        }
      },
      removeRef(i) { this.refs.splice(i, 1); },
      clearRefs() { this.refs = []; },
      clearStart() { this.preview = ''; this.image = ''; },
      clearEnd() { this.preview2 = ''; this.image2 = ''; },
      // v1.0.43 从系统选图：文生图+广告图最近完成的生成图 → 首帧参考图（上传功能保留不变）
      async loadPick() {
        this.pickOpen = true; this.pickBusy = true;
        try {
          const d = await api('GET', '/image/queue');
          this.pickList = (d.jobs || []).filter((j) => j.status === 'done' && j.image_path).map((j) => {
            let wh = '', mode = '';
            try {
              const pp = JSON.parse(j.params || '{}');
              if (pp.width && pp.height) wh = pp.width + '×' + pp.height;
              if (pp.gen_mode === 'hires') mode = '重绘'; else if (pp.gen_mode === 'upscale') mode = '超分';
            } catch (e) { /* 参数解析失败照样可选 */ }
            const file = basename(j.image_path);
            return { id: j.id, file, wh, mode, src: { ad: '分层图', h3: '文生图H3' }[j.source] || '文生图Z', url: authed('/api/image/output/' + file), prompt: String(j.prompt || '').slice(0, 40) };
          });
        } catch (e) { alert('拉取历史图失败：' + e.message); this.pickOpen = false; }
        this.pickBusy = false;
      },
      openPick(target) { this.pickTarget = ['end', 'ref'].includes(target) ? target : 'first'; this.loadPick(); },
      // 需求28 粘贴图片：首帧/尾帧参考图（单槽，新粘覆盖）；v1.0.55 人物参考（多张追加）
      openPaste(target) {
        this.pasteTarget = ['end', 'ref'].includes(target) ? target : 'first';
        this.pasteTitle = { end: '粘贴图片（作为尾帧参考图）', ref: '粘贴图片（追加为人物参考图，可连续多张）' }[this.pasteTarget] || '粘贴图片（作为首帧参考图）';
        this.pasteOpen = true;
      },
      onPasteConfirm(list) {
        this.pasteOpen = false;
        if (this.pasteTarget === 'ref') { this.addRefs((list || []).map((it) => ({ dataUrl: it.dataUrl, ext: it.ext }))); return; }
        const it = list && list[list.length - 1]; if (!it) return;
        if (this.pasteTarget === 'end') { this.setEnd(it.dataUrl, it.ext); }
        else { this.preview = it.dataUrl; this.image = it.dataUrl; this.image_ext = it.ext; }
      },
      async pickOne(it) {
        this.pickBusy = true;
        try {
          const r = await fetch(it.url);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          const blob = await r.blob();
          const dataUrl = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读取失败')); fr.readAsDataURL(blob); });
          if (this.pickTarget === 'end') { this.setEnd(dataUrl, it.file.split('.').pop() || 'png'); }
          else if (this.pickTarget === 'ref') { this.addRefs([{ dataUrl, ext: it.file.split('.').pop() || 'png' }]); }
          else { this.preview = dataUrl; this.image = dataUrl; this.image_ext = (it.file.split('.').pop() || 'png'); }
          this.pickOpen = false;
        } catch (e) { alert('选图失败：' + e.message); }
        this.pickBusy = false;
      },
      statusLabel(s) { return { pending: '排队中', running: '生成中', done: '完成', failed: '失败' }[s] || s; },
      // 秒数框：按当前帧率换算并回填帧数（第 12 条需求）
      secToFrames() {
        const s = Number(this.shotSec);
        if (!Number.isFinite(s) || s <= 0) return;
        this.p.frames_per_shot = Math.max(5, Math.min(481, Math.round(s * (Number(this.p.fps) || 24))));
      },
      // v1.0.14 第13条：页头停止按钮（任务中心同款安全语义：排队中出队、执行中核实后打断）
      async stopJob() {
        if (!this.job || !this.job.id) { alert('任务刚提交、还没登记好，1-2 秒后再点停止'); return; }
        try { await api('POST', '/tasks/h3/' + this.job.id + '/stop'); this.statusText = '停止中…'; }
        catch (e) { alert(e.message); }
      },
      // 需求30 批量生成：逐段提交（串行 await，共用参数区设置；i2v 模式首帧/尾帧共用当前已选）
      openBatch() { this.batchOpen = true; },
      closeBatch() { if (!this.batchBusy) this.batchOpen = false; },
      async submitBatch() {
        const list = this.batchList;
        if (!list.length || this.batchBusy) return;
        // v1.0.60 软闸：批量更疯，超训练上限先确认
        if (Number(this.p.frames_per_shot) > 362 && !confirm('每镜头 ' + this.p.frames_per_shot + ' 帧已超过模型训练上限 362 帧（≈15 秒），批量提交会把算力机压到小时级。确定仍要继续？')) return;
        this.batchBusy = true; this.batchDone = 0;
        const _busy = await busyBefore();
        let ok = 0; const fails = [];
        for (const it of list) {
          try {
            const body = {
              prompt: it.text,
              image: this.mode === 'i2v' ? this.image : undefined, image_ext: this.image_ext,
              end_image: (this.mode === 'i2v' && this.image2) ? this.image2 : undefined, end_image_ext: this.image2_ext,
              ref_images: this.refs.map((r) => ({ data: r.dataUrl, ext: r.ext })), // v1.0.55 批量共用当前人物参考
              model_name: this.p.model_name, clip_name: this.p.clip_name, clip_type: this.p.clip_type, mmproj_name: this.p.mmproj_name,
              video_vae: this.p.video_vae, audio_vae: this.p.audio_vae,
              shot_count: this.p.shot_count, width: this.p.width, height: this.p.height, frames_per_shot: this.p.frames_per_shot,
              seed: this.p.seed, steps: this.p.steps, seed_per_shot: this.p.seed_per_shot, sampler_name: this.p.sampler_name, scheduler: this.p.scheduler,
              self_anchor_voice: this.p.self_anchor_voice, output_scale: this.p.output_scale,
              fps: this.p.fps, bit_depth: this.p.bit_depth, color_space: this.p.color_space,
            };
            await api('POST', '/h3/generate', body);
            ok++;
          } catch (e) { fails.push(it.title + '：' + e.message); }
          this.batchDone++;
        }
        this.batchBusy = false;
        this.refreshQueue(); queueBusyNotice(_busy);
        if (fails.length) alert('批量提交完成：成功 ' + ok + ' 个，失败 ' + fails.length + ' 个\n' + fails.join('\n'));
        else { this.batchOpen = false; this.statusText = '批量提交完成（' + ok + ' 个任务已排队）'; }
      },
      fmtDur(ms) {
        if (!ms || ms <= 0) return '-';
        if (ms < 1000) return ms + 'ms';
        if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
        const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
        return m + 'm' + (s ? s + 's' : '');
      },
      vidUrl(q) { return authed('/api/h3/output/' + basename(q.video_path)); },
      // v1.0.15：点开大窗播放，← → 在全部已完成视频间前后翻页（不限缩略图条的当前页）
      openVid(v) {
        const items = this.doneVideos.map((q) => ({ kind: 'video', url: this.vidUrl(q), title: q.prompt || '', sub: '#' + q.id + ' · ' + (q.created_at || '') }));
        openViewer(items, this.doneVideos.indexOf(v));
      },
      modelOf(q) { try { const pr = JSON.parse(q.params || '{}'); return basename(pr.model_name || ''); } catch { return '-'; } },
      // v1.0.48 需求29：队列尺寸列（宽×高；首尾帧模式加标记）
      whOf(q) {
        try {
          const pr = JSON.parse(q.params || '{}');
          const w = Number(pr.width), h = Number(pr.height);
          const wh = (w > 0 && h > 0) ? w + '×' + h : '-';
          if (pr.mode === 'flf') return wh + ' 首尾';
          return pr.ref_count ? wh + ' 人物' + pr.ref_count : wh; // v1.0.55 参考图张数标记
        } catch { return '-'; }
      },
      async refreshQueue() {
        try {
          const d = await api('GET', '/h3/queue'); this.queue = d.jobs || [];
          // 切页回来：接续自己进行中的任务，页头进度条照常显示、耗时从 created_at 起算
          if (!this.busy) {
            const run = (this.queue || []).find((q) => (q.status === 'running' || q.status === 'pending') && q.user_id === store.user.id);
            if (run) {
              this.busy = true; this.statusText = run.status === 'pending' ? '排队中…' : '生成中…';
              this.startClock(Date.parse(String(run.created_at || '').replace(' ', 'T')) || undefined);
              this.poll(run.id);
            }
          }
        } catch (e) {}
      },
      async openFolder() { try { await api('POST', '/h3/open-output-dir'); } catch (e) { alert(e.message); } },
      async regen(q) {
        // v1.0.38 再生成：提示词/负向/全部节点参数还原到上方，i2v 模式首帧从服务器取回（不自动提交）
        let pp = {};
        try { pp = JSON.parse(q.params || '{}'); } catch (e) { pp = {}; }
        for (const k of Object.keys(this.p)) if (pp[k] !== undefined) this.p[k] = pp[k];
        this.p.prompt = String(q.prompt || ''); // 提示词在独立列不在 params
        if (this.p.model_name === 'MiniMax-H3-fl2va-curve-Q4_0.gguf') this.p.model_name = ''; // v1.0.58 同 loadDefaults：默认名不冒充手选
        this.sizePreset = matchH3VPreset(this.p.width, this.p.height); // 需求33：还原尺寸恰为某预设时下拉同步
        this.mode = pp.mode === 't2v' ? 't2v' : 'i2v';
        let note = '';
        if (q.image_path) {
          try {
            const r = await fetch(authed('/api/generate/upload/' + basename(q.image_path)));
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const blob = await r.blob();
            const du = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读取失败')); fr.readAsDataURL(blob); });
            this.image = du; this.preview = du; this.image_ext = basename(q.image_path).split('.').pop() || 'png';
          } catch (e) { note = '（首帧取回失败：' + e.message + '，请重新上传）'; }
        } else { this.image = ''; this.preview = ''; }
        // v1.0.48 需求29：首尾帧任务的尾帧也一并取回
        if (pp.end_image_path) {
          try {
            const r2 = await fetch(authed('/api/generate/upload/' + basename(pp.end_image_path)));
            if (!r2.ok) throw new Error('HTTP ' + r2.status);
            const blob2 = await r2.blob();
            const du2 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读取失败')); fr.readAsDataURL(blob2); });
            this.image2 = du2; this.preview2 = du2; this.image2_ext = basename(pp.end_image_path).split('.').pop() || 'png';
          } catch (e) { if (!note) note = '（尾帧取回失败：' + e.message + '，请重新上传）'; }
        } else { this.image2 = ''; this.preview2 = ''; }
        // v1.0.55：人物参考图一并还原（存的是上传目录路径，经 /api/generate/upload 取回）
        this.refs = [];
        if (Array.isArray(pp.ref_image_paths) && pp.ref_image_paths.length) {
          for (const rp of pp.ref_image_paths.slice(0, 3)) {
            try {
              const r3 = await fetch(authed('/api/generate/upload/' + basename(rp)));
              if (!r3.ok) throw new Error('HTTP ' + r3.status);
              const blob3 = await r3.blob();
              const du3 = await new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => rej(new Error('读取失败')); fr.readAsDataURL(blob3); });
              this.refs.push({ dataUrl: du3, ext: basename(rp).split('.').pop() || 'png' });
            } catch (e) { if (!note) note = '（人物参考图取回失败：' + e.message + '，请重新添加）'; }
          }
        }
        this.statusText = '已还原任务 #' + q.id + ' 的参数，确认后点「开始生成」' + note;
        window.scrollTo({ top: 0, behavior: 'smooth' });
      },
      async go() {
        if (!this.p.prompt.trim()) { alert('请输入提示词'); return; }
        if (this.mode === 'i2v' && !this.image) { alert('图生视频模式请先上传首帧参考图'); return; }
        // v1.0.60 软闸：超训练上限先打招呼（481 帧实测会把后端压到轮询失联级 lag）
        if (Number(this.p.frames_per_shot) > 362 && !confirm('每镜头 ' + this.p.frames_per_shot + ' 帧（≈' + (this.p.frames_per_shot / this.p.fps).toFixed(1) + ' 秒）已超过模型训练上限 362 帧（≈15 秒）：采样时间会暴涨（3060 上 2 小时级）、画面后段可能不稳。长片建议用「镜头数」分段（每镜头 ≤362 帧）。确定仍要继续？')) return;
        this.busy = true; this.job = null; this.statusText = '提交中…'; this.pctHigh = 0; this.startClock();
        try {
          const body = {
            prompt: this.p.prompt,
            image: this.mode === 'i2v' ? this.image : undefined, image_ext: this.image_ext,
            // v1.0.48 需求29：尾帧（仅在 i2v 且已传时发送；两张都在 = 首尾帧模式）
            end_image: (this.mode === 'i2v' && this.image2) ? this.image2 : undefined, end_image_ext: this.image2_ext,
            // v1.0.55 人物参考图（≤3 张；与尾帧互斥由前端自动清 + 后端拦截双保险）
            ref_images: this.refs.map((r) => ({ data: r.dataUrl, ext: r.ext })),
            model_name: this.p.model_name, clip_name: this.p.clip_name, clip_type: this.p.clip_type, mmproj_name: this.p.mmproj_name,
            video_vae: this.p.video_vae, audio_vae: this.p.audio_vae,
            shot_count: this.p.shot_count, width: this.p.width, height: this.p.height, frames_per_shot: this.p.frames_per_shot,
            seed: this.p.seed, steps: this.p.steps, seed_per_shot: this.p.seed_per_shot, sampler_name: this.p.sampler_name, scheduler: this.p.scheduler,
            self_anchor_voice: this.p.self_anchor_voice, output_scale: this.p.output_scale,
            fps: this.p.fps, bit_depth: this.p.bit_depth, color_space: this.p.color_space,
          };
          const _busy = await busyBefore();
          const d = await api('POST', '/h3/generate', body);
          this.poll(d.id); this.refreshQueue(); queueBusyNotice(_busy);
        } catch (e) { alert(e.message); this.statusText = ''; this.busy = false; this.stopClock(); }
      },
      poll(id) {
        this.timer = setInterval(async () => {
          try {
            const d = await api('GET', '/h3/job/' + id);
            this.job = d.job;
            const p = Number(d.job.progress_pct);
            if (Number.isFinite(p)) this.pctHigh = Math.max(this.pctHigh, Math.min(100, p));
            if (d.job.status === 'done') { this.statusText = '完成'; this.busy = false; this.stopClock(); clearInterval(this.timer); this.refreshQueue(); }
            else if (d.job.status === 'failed') { this.statusText = '失败'; this.busy = false; this.stopClock(); clearInterval(this.timer); this.refreshQueue(); }
            else this.statusText = d.job.progress || (d.job.status === 'pending' ? '排队中…' : '生成中…');
          } catch (e) { clearInterval(this.timer); this.busy = false; this.stopClock(); this.statusText = ''; }
        }, 3000);
      },
    },
    beforeUnmount() { if (this.timer) clearInterval(this.timer); if (this.qTimer) clearInterval(this.qTimer); },
  };

  // ---------- 我的历史（矩阵卡片，含首尾视频/文生图/视频生成三类） ----------
  const MyHistory = {
    template: `
    <div>
      <div class="page-head"><h2>我的历史</h2><div class="desc">你的全部生成记录（首尾视频 · 文生图 · 生视频H3），矩阵卡片展示</div></div>
      <div v-if="!jobs.length" class="muted">还没有生成记录</div>
      <div v-else class="hist-grid">
        <div v-for="j in jobs" :key="j.type + '-' + j.id" class="hist-card">
          <div class="hist-thumb">
            <video v-if="isVideo(j) && j.video_path" :src="fileUrl(j)" controls preload="metadata"></video>
            <img v-else-if="!isVideo(j) && j.image_path" :src="fileUrl(j)" />
            <div v-else class="muted">无文件</div>
          </div>
          <div class="hist-meta">
            <div class="row" style="flex:none;align-items:center;justify-content:space-between">
              <span class="badge" :class="typeBadge(j.type)">{{ typeLabel(j.type) }}</span>
              <span class="badge" :class="j.status==='done'?'ok':(j.status==='failed'?'err':'warn')">{{ statusLabel(j.status) }}</span>
            </div>
            <div class="prompt" :title="j.prompt">{{ j.prompt || '-' }}</div>
            <div class="muted">#{{ j.id }} · {{ fmtTime(j.created_at) }}</div>
            <div v-if="j.error" class="hint" style="color:var(--danger)">{{ j.error }}</div>
            <div class="row" style="flex:none;margin-top:6px;gap:8px">
              <a v-if="j.file_path" class="btn sm" :href="fileUrl(j)" download>下载</a>
              <button class="btn sm danger" @click="del(j)">删除</button>
            </div>
          </div>
        </div>
      </div>
    </div>`,
    data() { return { jobs: [] }; },
    async mounted() { const d = await api('GET', '/history'); this.jobs = d.jobs; },
    methods: {
      fmtTime,
      isVideo(j) { return j.type === 'i2v' || j.type === 'h3'; },
      typeLabel(t) { return { i2v: '首尾视频', zimage: '文生图', h3: '生视频H3' }[t] || t; },
      typeBadge(t) { return { i2v: 'dim', zimage: 'ok', h3: 'warn' }[t] || 'dim'; },
      statusLabel(s) { return { pending: '排队中', running: '生成中', done: '完成', failed: '失败' }[s] || s; },
      outPath(j) {
        const base = basename(j.file_path);
        if (j.type === 'zimage') return '/api/image/output/' + base;
        if (j.type === 'h3') return '/api/h3/output/' + base;
        return '/api/generate/output/' + base;
      },
      fileUrl(j) { return authed(this.outPath(j)); },
      async del(j) { if (!confirm('删除这条记录及其文件？')) return; await api('DELETE', '/history/' + j.type + '/' + j.id); this.jobs = this.jobs.filter((x) => !(x.id === j.id && x.type === j.type)); },
    },
  };

  // ---------- 用户历史（管理员） ----------
  const UserHistory = {
    template: `
    <div>
      <div class="page-head"><h2>用户历史</h2><div class="desc">全部用户的生成历史与生成次数（首尾视频 · 文生图 · 生视频H3）——点选用户查看其生成记录</div></div>
      <div class="card"><h3>生成次数汇总（点一行 = 只看这个用户）</h3>
        <table><thead><tr><th></th><th>用户</th><th>昵称</th><th>角色</th><th>已用</th><th>额度</th><th>成功</th><th>失败</th></tr></thead>
        <tbody><tr v-for="s in summary" :key="s.id" style="cursor:pointer" :class="{sel: selUser === s.username}" @click="pickUser(s.username)">
          <td>{{ selUser === s.username ? '✓' : '' }}</td>
          <td>{{ s.username }}</td>
          <td>{{ s.display_name }}</td>
          <td>{{ s.role }}</td>
          <td>{{ s.used }}</td>
          <td>{{ s.quota < 0 ? '不限' : s.quota }}</td>
          <td>{{ s.done }}</td>
          <td>{{ s.failed }}</td>
        </tr></tbody></table>
      </div>
      <div class="card">
        <div class="row" style="flex:none;align-items:center;justify-content:space-between;margin-bottom:10px;flex-wrap:wrap;gap:8px">
          <h3 style="margin:0">{{ selUser ? '「' + selUser + '」的生成记录' : '生成记录（未选用户）' }}</h3>
          <div v-if="selUser && filteredJobs.length" class="pager" style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <button class="btn sm" :disabled="page === 0" @click="page--">‹ 上一页</button>
            <span class="muted">第 {{ page + 1 }} / {{ totalPages }} 页 · 共 {{ filteredJobs.length }} 条</span>
            <button class="btn sm" :disabled="page >= totalPages - 1" @click="page++">下一页 ›</button>
            <select v-model.number="pageSize" @change="page = 0" style="width:auto">
              <option v-for="n in [10, 20, 30, 50]" :key="n" :value="n">{{ n }} 条/页</option>
            </select>
          </div>
        </div>
        <div v-if="!selUser" class="muted" style="padding:18px 4px">👆 点选上方汇总表里的一个用户，这里就只显示 TA 生成过的任务记录。</div>
        <template v-else>
        <div v-if="!filteredJobs.length" class="muted" style="padding:18px 4px">该用户暂无生成记录。</div>
        <table v-else><thead><tr><th>#</th><th>类型</th><th>用户</th><th>提示词</th><th>状态</th><th>时间</th><th>结果</th><th></th></tr></thead>
        <tbody><tr v-for="j in pageJobs" :key="j.type + '-' + j.id">
          <td>{{ j.id }}</td>
          <td><span class="badge" :class="typeBadge(j.type)">{{ typeLabel(j.type) }}</span></td>
          <td>{{ j.display_name || j.username }}</td>
          <td style="max-width:260px" class="ellip" :title="j.prompt">{{ j.prompt || '-' }}</td>
          <td><span class="badge" :class="j.status==='done'?'ok':(j.status==='failed'?'err':'warn')">{{ statusLabel(j.status) }}</span></td>
          <td class="muted">{{ fmtTime(j.created_at) }}</td>
          <td style="white-space:nowrap">
            <a v-if="j.file_path" class="btn sm" :href="fileUrl(j)" target="_blank">查看</a>
            <span v-else class="muted">—</span>
          </td>
          <td><button class="btn sm danger" @click="del(j)">删除</button></td>
        </tr></tbody></table>
        </template>
      </div>
    </div>`,
    data() { return { summary: [], jobs: [], selUser: null, page: 0, pageSize: 10 }; },
    async mounted() { const [a, b] = await Promise.all([api('GET', '/user-history/summary'), api('GET', '/user-history')]); this.summary = a.summary; this.jobs = b.jobs; },
    computed: {
      filteredJobs() { return this.selUser ? this.jobs.filter((j) => j.username === this.selUser) : []; },
      totalPages() { return Math.max(1, Math.ceil(this.filteredJobs.length / this.pageSize)); },
      pageJobs() {
        if (this.page > this.totalPages - 1) this.page = this.totalPages - 1;
        return this.filteredJobs.slice(this.page * this.pageSize, (this.page + 1) * this.pageSize);
      },
    },
    methods: {
      pickUser(u) { this.selUser = (this.selUser === u ? null : u); this.page = 0; },
      fmtTime,
      typeLabel(t) { return { i2v: '首尾视频', zimage: '文生图', h3: '生视频H3' }[t] || t; },
      typeBadge(t) { return { i2v: 'dim', zimage: 'ok', h3: 'warn' }[t] || 'dim'; },
      statusLabel(s) { return { pending: '排队中', running: '生成中', done: '完成', failed: '失败' }[s] || s; },
      outPath(j) {
        const base = basename(j.file_path);
        if (j.type === 'zimage') return '/api/image/output/' + base;
        if (j.type === 'h3') return '/api/h3/output/' + base;
        return '/api/generate/output/' + base;
      },
      fileUrl(j) { return authed(this.outPath(j)); },
      async del(j) { if (!confirm('删除这条记录及其文件？')) return; await api('DELETE', '/history/' + j.type + '/' + j.id); this.jobs = this.jobs.filter((x) => !(x.id === j.id && x.type === j.type)); },
    },
  };

  // ---------- 模型配置 ----------
  const Models = {
    template: `
    <div>
      <div class="page-head"><h2>模型配置</h2><div class="desc">四个后端各自的模型与地址：文生图 Z-image · 视频生成 H3 · 首尾视频 WAN2.2 · 配音 MOSS</div></div>
      <div class="card">
        <h3>输出目录（生成文件保存位置，三后端共用）</h3>
        <div class="muted" style="margin-bottom:10px;word-break:break-all">当前：{{ outputDir || '（默认 data/output）' }}</div>
        <div class="row" style="flex:none;gap:8px;align-items:center">
          <input v-model="outputDir" style="flex:1;max-width:520px" placeholder="留空则使用默认 data/output" />
          <button class="btn sm" @click="openBrowseOutput">浏览…</button>
          <button class="btn primary" @click="saveOutputDir">保存</button>
        </div>
      </div>
      <div class="tabs">
        <button class="tab" :class="{active: tab==='zimage'}" @click="tab='zimage'">文生图 Z-image</button>
        <button class="tab" :class="{active: tab==='h3'}" @click="tab='h3'">视频生成 H3</button>
        <button class="tab" :class="{active: tab==='i2v'}" @click="tab='i2v'">首尾视频 WAN2.2</button>
        <button class="tab" :class="{active: tab==='tts'}" @click="tab='tts'; loadTts()">配音 MOSS</button>
      </div>
      <template v-if="tab!=='tts'">
      <div class="card">
        <h3>{{ tabLabel }} 后端</h3>
        <div class="row" style="flex:none;margin-bottom:10px;align-items:center">
          <template v-if="tab!=='h3'">
            <label><input type="radio" value="local" v-model="backends[tab].mode" /> 本地（本机 ComfyUI 8189）</label>
            <label><input type="radio" value="remote" v-model="backends[tab].mode" /> 远端（内网局域网 ComfyUI）</label>
          </template>
          <span v-else class="muted">H3 与首尾视频/文生图共用统一后端（8189）</span>
          <span class="badge" :class="backendStatus[tab].running ? 'ok' : 'err'">{{ backendStatus[tab].running ? '在线' : '离线' }}</span>
          <span class="muted" v-if="backendStatus[tab].device">{{ backendStatus[tab].device }}</span>
        </div>
        <div v-if="tab==='zimage' && backends.zimage.mode==='local'" class="alert ok" style="margin:0 0 12px">
          统一后端：8189（ComfyUI 0.34）已支持 Z-Image 文生图、WAN2.2 首尾视频与 MiniMax-H3 视频生成。
        </div>
        <div v-if="tab==='h3' || backends[tab].mode==='remote'" class="field" style="max-width:520px">
          <label>ComfyUI 地址</label>
          <input v-model="backends[tab].url" :placeholder="'http://192.168.110.57:8189'" />
        </div>
        <div class="row" style="flex:none">
          <button class="btn primary" @click="saveBackend">保存</button>
          <button class="btn" @click="testBackend">测试连通</button>
          <button v-if="tab!=='h3' && backends[tab].mode==='local' && !backendStatus[tab].running" class="btn" :disabled="starting" @click="startBackend">{{ starting ? '启动中…（冷启动较慢）' : '启动本机模型' }}</button>
        </div>
        <div class="row" style="flex:none;margin-top:12px;align-items:center;gap:8px;flex-wrap:wrap">
          <button class="btn" @click="configureComputeNode">按算力端配置</button>
          <span v-if="computeInfo" class="muted" style="word-break:break-all">{{ computeInfo }}</span>
        </div>
      </div>
      <div class="card">
        <div class="row" style="flex:none;align-items:center;justify-content:space-between;margin-bottom:10px">
          <h3 style="margin:0">{{ tabLabel }} 模型文件</h3>
          <button class="btn primary sm" @click="openAdd">＋ 新增模型</button>
        </div>
        <div class="muted" style="margin-bottom:10px;word-break:break-all">模型目录：{{ backends[tab].mode==='remote' ? '远端 ' + backends[tab].url + '（模型在算力机上管理，浏览/拉取仅本地模式可用）' : modelsRoot }}</div>
        <table><thead><tr><th>模型</th><th>文件名 / 路径</th><th>类别</th><th>状态</th><th>操作</th></tr></thead>
        <tbody><tr v-for="m in groupModels" :key="m.key">
          <td>{{ m.name }}</td>
          <td>
            <input v-model="m.path" style="width:100%;padding:6px 8px;border:1px solid var(--border);border-radius:6px;background:var(--bg-input);color:var(--text)" />
            <div class="muted" style="font-size:11px;margin-top:4px;word-break:break-all">{{ fullPath(m) }}</div>
          </td>
          <td class="muted">{{ m.kind }}</td>
          <td>
            <span v-if="m.present === null" class="badge" title="远端列表暂不可达，未校验存在性">未校验</span>
            <span v-else class="badge" :class="m.present ? 'ok' : 'err'">{{ m.present ? (isRemote(m) ? '远端已存在' : '已存在') : (isRemote(m) ? '远端缺失' : '缺失') }}</span>
          </td>
          <td style="white-space:nowrap">
            <button class="btn sm" @click="save(m)">保存</button>
            <button v-if="!isRemote(m)" class="btn sm" @click="openBrowse(m)">浏览</button>
            <button v-if="!isRemote(m)" class="btn sm" @click="openPull(m)">拉取</button>
            <button class="btn sm danger" @click="remove(m)">删除</button>
          </td>
        </tr></tbody></table>
      </div>
      <div v-if="pullStatus.current || pullStatus.queue.length" class="card">
        <h3>模型拉取</h3>
        <template v-if="pullStatus.current">
          <div class="row" style="flex:none;align-items:center;gap:10px;flex-wrap:wrap">
            <b>{{ pullStatus.current.filename }}</b>
            <span class="badge dim">{{ pullStatus.current.kind }}</span>
            <span class="muted">{{ bytes(pullStatus.current.got) }} / {{ pullStatus.current.total ? bytes(pullStatus.current.total) : '?' }}<template v-if="pullStatus.current.speed"> · {{ bytes(pullStatus.current.speed) }}/s</template></span>
            <span style="flex:1"></span>
            <button class="btn sm danger" @click="cancelPull">取消下载（保留断点）</button>
          </div>
          <div class="progress" style="margin-top:8px"><div :style="{width: pct + '%'}"></div></div>
          <div class="muted" style="margin-top:4px;font-size:12px">{{ pct }}%<template v-if="pullStatus.current.log"> · {{ pullStatus.current.log }}</template></div>
        </template>
        <div v-for="q in pullStatus.queue" :key="q.id" class="row" style="flex:none;align-items:center;gap:10px;margin-top:6px">
          <span class="badge dim">排队</span>
          <span class="ellip">{{ q.filename }}</span>
          <span class="muted">{{ bytes(q.total || 0) }}</span>
          <span style="flex:1"></span>
          <button class="btn sm" @click="rmQueue(q)">移出队列</button>
        </div>
      </div>
      <div v-if="pullStatus.history && pullStatus.history.length" class="card">
        <h3>最近拉取记录</h3>
        <div v-for="h in pullStatus.history.slice(0, 5)" :key="h.id" class="row" style="flex:none;align-items:center;gap:10px;font-size:13px;padding:3px 0">
          <span class="badge" :class="h.status === 'done' ? 'ok' : (h.status === 'cancelled' ? 'dim' : 'err')">{{ { done: '完成', failed: '失败', cancelled: '已取消' }[h.status] || h.status }}</span>
          <span class="ellip">{{ h.filename }}</span>
          <span v-if="h.error" class="muted ellip" style="max-width:40%">{{ h.error }}</span>
          <span style="flex:1"></span>
          <span class="muted">{{ fmtTime(new Date(h.endedAt)) }}</span>
        </div>
      </div>
      </template>
      <template v-else>
      <div class="card">
        <h3>MOSS 引擎状态</h3>
        <div class="row" style="flex:none;flex-wrap:wrap;align-items:center">
          <span class="badge" :class="ttsEngineBadge.cls">{{ ttsEngineBadge.text }}</span>
          <span class="muted">音色数：{{ ttsEngine.voice_count }}</span>
          <span v-if="ttsEngine.remote" class="badge dim" :title="ttsEngine.url">远端引擎</span>
          <span v-if="!ttsEngine.remote && !ttsEngine.installed" class="badge err">未安装</span>
          <button v-if="!ttsEngine.remote && !ttsEngine.installed" class="btn primary sm" @click="ttsInstall">一键安装引擎</button>
          <button v-else-if="!ttsEngine.remote" class="btn sm" @click="ttsWarmup">启动/预热引擎</button>
          <button class="btn sm" @click="loadTts(true)">刷新</button>
        </div>
        <div v-if="ttsEngine.error" class="alert err" style="margin-top:10px">{{ ttsEngine.error }}</div>
      </div>
      <div class="card">
        <h3>配音后端（本地 / 内网远端）</h3>
        <div class="row" style="flex:none;margin-bottom:10px;align-items:center">
          <label><input type="radio" value="local" v-model="ttsBackend.mode" /> 本地（本机 TTS 引擎）</label>
          <label><input type="radio" value="remote" v-model="ttsBackend.mode" /> 远端（内网局域网 TTS）</label>
        </div>
        <div v-if="ttsBackend.mode==='remote'" class="field" style="max-width:520px">
          <label>TTS 地址</label>
          <input v-model="ttsBackend.url" placeholder="http://192.168.110.57:9640" />
        </div>
        <div class="row" style="flex:none">
          <button class="btn primary" @click="ttsSaveBackend">保存</button>
          <button class="btn" @click="ttsTestBackend">测试连通</button>
          <span class="muted" v-if="ttsBackend.mode==='local'">本机引擎将在首次合成时自动拉起（127.0.0.1:9640）</span>
          <span class="muted" v-if="ttsBackend.mode==='remote'">参考音频将以内容上传到远端引擎合成</span>
        </div>
        <div class="row" style="flex:none;margin-top:10px;align-items:center;gap:8px;flex-wrap:wrap">
          <button class="btn" @click="ttsConfigureComputeNode">按算力端配置</button>
          <span v-if="ttsComputeInfo" class="muted" style="word-break:break-all">{{ ttsComputeInfo }}</span>
        </div>
      </div>
      </template>
      <div v-if="dialog" class="overlay">
        <div class="dialog">
          <h3>拉取模型：{{ dialog.name }}</h3>
          <div class="field"><label>来源（完整 URL，或 hf:仓库名/文件路径）</label>
            <input v-model="dialog.source" placeholder="https://… 或 hf:repo/model.safetensors" />
            <div v-if="dialog.builtin" class="muted" style="font-size:12px;margin-top:4px">已内置官方远端地址（hf-mirror.com），可直接开始拉取。</div>
            <div v-else class="alert err" style="margin-top:6px">该模型未内置下载地址（如 NSFW LoRA 需到 civitai 登录后获取直链），请填写来源后再拉取。</div>
          </div>
          <div class="field"><label>目标文件名</label><input v-model="dialog.filename" /></div>
          <div class="muted">类别：{{ dialog.kind }} · 将下载到 ComfyUI/models 对应目录 · 支持断点续传（取消后重新拉取会接着下）</div>
          <label v-if="dialog.source" class="chk" style="margin-top:8px"><input type="checkbox" v-model="dialog.saveUrl" />把这个来源保存为该模型的默认地址</label>
          <div class="actions">
            <button class="btn" @click="dialog = null">取消</button>
            <button class="btn primary" :disabled="!dialog.source.trim()" @click="doPull">开始拉取</button>
          </div>
        </div>
      </div>
      <div v-if="browser" class="overlay">
        <div class="dialog" style="width:640px">
          <h3>{{ browseTarget === '__outdir__' ? '选择输出目录' : '选择模型文件' }}</h3>
          <div class="muted" style="margin-bottom:8px;word-break:break-all">{{ browser.dir }}</div>
          <div class="row" style="flex:none;margin-bottom:8px">
            <button v-if="browseTarget === '__outdir__'" class="btn primary sm" @click="pickOutputDir">📌 选择此目录</button>
            <button class="btn sm" :disabled="!browser.canUp" @click="browse(browser.parent)">⬆ 上一级</button>
            <button class="btn sm" @click="browse(browser.root)">回到模型目录</button>
            <button class="btn sm" @click="browser = null">关闭</button>
          </div>
          <div style="max-height:360px;overflow:auto;border:1px solid var(--border);border-radius:6px">
            <div v-for="d in browser.dirs" :key="d.path" class="browse-item" @click="browse(d.path)">📁 {{ d.name }}</div>
            <div v-if="browseTarget !== '__outdir__'" v-for="f in browser.files" :key="f.path" class="browse-item" @click="pickFile(f)">📄 {{ f.name }}</div>
            <div v-if="!browser.dirs.length && !browser.files.length" class="muted" style="padding:12px">空目录</div>
          </div>
        </div>
      </div>
      <div v-if="showAdd" class="overlay">
        <div class="dialog">
          <h3>新增模型</h3>
          <div class="field"><label>模型名称</label><input v-model="newModel.name" placeholder="例如：Flux.1 Dev" /></div>
          <div class="field"><label>类别</label>
            <select v-model="newModel.kind">
              <option value="unet">UNet / 主模型</option>
              <option value="diffusion_model">Diffusion Model</option>
              <option value="text_encoder">文本编码器</option>
              <option value="vae">VAE 解码器</option>
              <option value="clip_vision">CLIP 视觉</option>
              <option value="lora">LoRA</option>
              <option value="interpolation">帧插值</option>
            </select>
          </div>
          <div class="field"><label>文件路径（相对 models/，或绝对路径）</label>
            <div class="row" style="flex:none;gap:8px">
              <input v-model="newModel.path" placeholder="如 unet/xxx.safetensors" style="flex:1" />
              <button class="btn sm" @click="openBrowseAdd">浏览…</button>
            </div>
          </div>
          <div class="actions">
            <button class="btn" @click="showAdd = false">取消</button>
            <button class="btn primary" @click="addModel">新增</button>
          </div>
        </div>
      </div>
    </div>`,
    data() { return { tab: 'zimage', backends: { i2v: { mode: 'local', url: '' }, zimage: { mode: 'local', url: '' }, h3: { mode: 'remote', url: '' } }, backendStatus: { i2v: { running: false, device: '' }, zimage: { running: false, device: '' }, h3: { running: false, device: '' } }, models: [], modelsRoot: '', outputDir: '', pullStatus: { running: false, current: null, queue: [], history: [] }, dialog: null, timer: null, starting: false, startTimer: null, showAdd: false, newModel: { name: '', kind: 'unet', path: '' }, computeInfo: '', browser: null, browseTarget: null, ttsEngine: { installed: false, remote: false, url: '', phase: 'stopped', error: '', voice_count: 0 }, ttsBackend: { mode: 'local', url: '' }, ttsComputeInfo: '' }; },
    computed: {
      pct() { const c = this.pullStatus.current; const t = c && c.total; return c && t ? Math.min(100, Math.round(c.got / t * 100)) : 0; },
      tabLabel() { return { zimage: '文生图 Z-image', h3: '视频生成 H3', i2v: '首尾视频 WAN2.2' }[this.tab]; },
      groupModels() { return (this.models || []).filter((m) => (m.grp || 'i2v') === this.tab); },
      // 配音 MOSS 引擎徽章（自语音配音页迁入）
      ttsEngineBadge() {
        const e = this.ttsEngine || {};
        if (e.remote) {
          if (!e.running) return { cls: 'err', text: '远端离线' };
          if (e.phase === 'ready') return { cls: 'ok', text: '远端就绪' };
          if (e.phase === 'error') return { cls: 'err', text: '远端出错' };
          return { cls: 'warn', text: '远端 ' + (e.phase || '加载中') };
        }
        return { cls: e.phase === 'ready' ? 'ok' : (e.phase === 'error' ? 'err' : 'warn'), text: e.phase || '未启动' };
      },
    },
    async mounted() { await this.reload(); this.loadBackends(); this.pollPull(); this.timer = setInterval(() => { if (this.pullStatus.running) this.pollPull(); }, 1500); this.statusTimer = setInterval(() => { if (this.tab === 'tts') this.loadTts(true); else this.testBackend(); }, 15000); },
    methods: {
      bytes, fmtTime,
      async reload() { const d = await api('GET', '/models'); this.models = d.models; this.modelsRoot = d.models_root || ''; this.outputDir = d.output_dir || ''; },
      async loadBackends() {
        try { const d = await api('GET', '/comfy/backends'); this.backends.i2v = d.i2v; this.backends.zimage = d.zimage; this.backends.h3 = d.h3; } catch (e) {}
        this.testBackend();
      },
      async saveBackend() { try { await api('PUT', '/comfy/config?kind=' + this.tab, { mode: this.backends[this.tab].mode, url: this.backends[this.tab].url }); alert('已保存'); await this.testBackend(); this.reload(); } catch (e) { alert(e.message); } },
      async testBackend() { try { const d = await api('GET', '/comfy/status?kind=' + this.tab); this.backendStatus[this.tab] = d; } catch (e) { this.backendStatus[this.tab] = { running: false, device: '' }; } },
      // ---------- 配音 MOSS（引擎/后端配置，自语音配音页迁入） ----------
      async loadTts(silent) {
        try { this.ttsEngine = await api('GET', '/tts/status'); } catch (e) { if (!silent) alert(e.message); }
        try { const d = await api('GET', '/tts/config'); this.ttsBackend.mode = d.mode; this.ttsBackend.url = d.url; } catch (e) { /* 非管理员拿不到配置：保持本地默认展示 */ }
      },
      async ttsSaveBackend() { try { await api('PUT', '/tts/config', { mode: this.ttsBackend.mode, url: this.ttsBackend.url }); alert('已保存'); this.loadTts(true); } catch (e) { alert(e.message); } },
      async ttsTestBackend() { await this.loadTts(true); },
      async ttsConfigureComputeNode() {
        if (!confirm('将本机 TTS 引擎配置为算力端：监听 0.0.0.0 供局域网设备调用。确认继续？')) return;
        try {
          const d = await api('POST', '/tts/compute-node');
          this.ttsComputeInfo = `已配置：本机 IP ${d.lanIp}，TTS 引擎监听 0.0.0.0:${d.port}（需重启服务生效）。远端设备可填 http://${d.lanIp}:${d.port}`;
          alert(this.ttsComputeInfo);
        } catch (e) { alert(e.message); }
      },
      async ttsInstall() { await api('POST', '/tts/engine/install', {}); this.loadTts(true); },
      async ttsWarmup() { try { await api('POST', '/tts/engine/warmup', {}); } catch (e) { alert(e.message); } this.loadTts(true); },
      async configureComputeNode() {
        if (!confirm('将本机配置为算力端（GPU 服务器）：ComfyUI 改为监听 0.0.0.0 供局域网设备连接，并生成 start-model.bat。确认继续？')) return;
        try {
          const d = await api('POST', '/comfy/compute-node');
          this.computeInfo = `已配置：本机 IP ${d.lanIp}，监听 0.0.0.0（统一后端：首尾视频/文生图/视频生成三合一）。已生成 start-model.bat，双击即可静默启动。`;
          alert(this.computeInfo);
        } catch (e) { alert(e.message); }
      },
      async startBackend() {
        this.starting = true;
        try {
          await api('POST', '/comfy/start');
          this.startTimer = setInterval(async () => {
            await this.testBackend();
            if (this.backendStatus[this.tab].running) { this.starting = false; clearInterval(this.startTimer); this.startTimer = null; }
          }, 3000);
        } catch (e) { alert(e.message); this.starting = false; }
      },
      async save(m) { try { await api('PUT', '/models/' + m.key, { name: m.name, path: m.path, enabled: m.enabled }); this.reload(); } catch (e) { alert(e.message); } },
      // 路径显示跟随该组后端配置：远端 → 「远端 url · models/目录/文件」；本地 → 本机 models 目录全路径
      isRemote(m) {
        const b = (m && m.remote) ? { mode: 'remote', url: m.remote.url } : this.backends[(m && m.grp) || 'i2v'];
        return !!(b && b.mode === 'remote');
      },
      fullPath(m) {
        const p = m.found_path || m.path || '';
        if (!p) return '';
        const folder = (m.remote && m.remote.folder) || m.folder || '';
        const seg = (folder && !/[\\/]/.test(p)) ? folder + '/' : ''; // p 已含子目录时不重复拼
        if (this.isRemote(m)) {
          const url = (m.remote && m.remote.url) || this.backends[(m.grp || 'i2v')].url || '';
          return '远端 ' + url.replace(/^https?:\/\//, '') + ' · models/' + seg + p;
        }
        if (/^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\') || p.startsWith('/')) return p;
        const root = (this.modelsRoot || '').replace(/[\\/]+$/, '');
        return root ? root + '/' + seg + p : p;
      },
      openBrowse(m) { this.browseTarget = m.key; this.browse(); },
      openBrowseAdd() { this.browseTarget = '__add__'; this.browse(); },
      openBrowseOutput() { this.browseTarget = '__outdir__'; this.browse(); },
      pickOutputDir() { this.outputDir = this.browser.dir; this.browser = null; this.browseTarget = null; },
      async saveOutputDir() { try { const d = await api('PUT', '/models/output-dir', { dir: this.outputDir }); this.outputDir = d.dir; alert('已保存输出目录'); } catch (e) { alert(e.message); } },
      async browse(dir) {
        try { this.browser = await api('GET', '/models/browse' + (dir ? '?dir=' + encodeURIComponent(dir) : '')); }
        catch (e) { alert(e.message); }
      },
      pickFile(f) {
        if (this.browseTarget === '__add__') this.newModel.path = f.rel;
        else { const m = this.models.find((x) => x.key === this.browseTarget); if (m) m.path = f.rel; }
        this.browser = null; this.browseTarget = null;
      },
      openAdd() { this.newModel = { name: '', kind: 'unet', path: '' }; this.showAdd = true; },
      async addModel() {
        if (!this.newModel.name.trim()) { alert('请填写模型名称'); return; }
        try { await api('POST', '/models', { ...this.newModel, grp: this.tab }); this.showAdd = false; this.reload(); }
        catch (e) { alert(e.message); }
      },
      async remove(m) {
        if (!confirm('删除模型配置「' + m.name + '」？\n（默认模型会在刷新后自动重建，自定义模型将永久删除）')) return;
        try { await api('DELETE', '/models/' + m.key); this.reload(); } catch (e) { alert(e.message); }
      },
      openPull(m) { this.dialog = { key: m.key, name: m.name, kind: m.kind, source: m.remote_url || '', filename: basename(m.path), builtin: !!m.builtin_url, saveUrl: false }; },
      async doPull() {
        try {
          const src = this.dialog.source.trim();
          await api('POST', '/models/pull', { key: this.dialog.key, filename: this.dialog.filename, source: src, kind: this.dialog.kind });
          if (this.dialog.saveUrl && src) { try { await api('PUT', '/models/' + this.dialog.key, { remote_url: src }); } catch (e) {} }
          this.dialog = null; this.pullStatus.running = true; this.pollPull();
        } catch (e) { alert(e.message); }
      },
      async pollPull() {
        try {
          const d = await api('GET', '/models/pull/status');
          const wasRunning = this.pullStatus.running;
          const prevDone = (this.pullStatus.history || []).filter((h) => h.status === 'done').length;
          this.pullStatus = d;
          const nowDone = (d.history || []).filter((h) => h.status === 'done').length;
          if ((wasRunning && !d.running) || nowDone > prevDone) this.reload(); // 有文件完成：刷新模型存在性
        } catch (e) {}
      },
      async cancelPull() { try { await api('POST', '/models/pull/cancel'); this.pollPull(); } catch (e) { alert(e.message); } },
      async rmQueue(q) { try { await api('DELETE', '/models/pull/' + q.id); this.pollPull(); } catch (e) { alert(e.message); } },
    },
    beforeUnmount() { if (this.timer) clearInterval(this.timer); if (this.startTimer) clearInterval(this.startTimer); if (this.statusTimer) clearInterval(this.statusTimer); },
  };

  // ---------- 语音配音 ----------
  const Voice = {
    template: `
    <div>
      <div class="page-head"><h2>语音配音</h2><div class="desc">语音克隆：上传参考音频即成为新音色；用音色给生成视频配音。引擎与后端配置已移至【模型配置 → 配音 MOSS】</div></div>
      <div class="card">
        <h3>文字转语音</h3>
        <div class="muted" style="margin-bottom:10px">录入文字，用所选音色（默认音色）合成语音，可播放、可下载；合成结果自动存入下方「我的配音」，也会出现在【视频剪辑】页的素材框里。</div>
        <div class="field">
          <label>要朗读的文字（{{ (ttsText || '').length }} / 2000）</label>
          <textarea v-model="ttsText" rows="4" maxlength="2000" placeholder="输入要合成的文字，例如：衍像，让每一帧都动起来。"></textarea>
        </div>
        <div class="row" style="flex:none;flex-wrap:wrap;align-items:flex-end">
          <div class="field" style="min-width:240px;margin:0">
            <label>音色</label>
            <select v-model.number="ttsVoice">
              <option :value="0">默认音色{{ defaultVoiceName ? '（' + defaultVoiceName + '）' : '' }}</option>
              <option v-for="v in voices" :key="v.id" :value="v.id">{{ v.name }}</option>
            </select>
          </div>
          <button class="btn primary" :disabled="speaking || !(ttsText || '').trim()" @click="speak">{{ speaking ? '合成中…' : '生成语音' }}</button>
        </div>
        <div v-if="speakUrl" style="margin-top:14px">
          <audio :src="speakUrl" controls autoplay style="width:100%"></audio>
          <div class="row" style="flex:none;margin-top:8px">
            <a class="btn sm" :href="speakUrl" :download="speakFname">下载 {{ speakFname }}</a>
            <span class="muted">已存入「我的配音」</span>
          </div>
        </div>
      </div>
      <div class="card">
        <h3>我的配音（{{ files.length }}）</h3>
        <div v-if="!files.length" class="muted">还没有配音文件——用上面「文字转语音」生成第一条。</div>
        <table v-else><thead><tr><th style="min-width:200px">文字</th><th>音色</th><th>试听</th><th>时间</th><th></th></tr></thead>
        <tbody><tr v-for="f in files" :key="f.id">
          <td class="ellip" style="max-width:320px" :title="f.text">{{ f.text }}</td>
          <td><span class="badge dim">{{ f.voice_name }}</span></td>
          <td><audio :src="fileAuthed(f)" controls preload="none" style="height:28px;min-width:220px"></audio></td>
          <td class="muted">{{ fmtTime(f.created_at) }}</td>
          <td style="white-space:nowrap">
            <a class="btn sm" :href="fileAuthed(f)" :download="'衍像语音_' + f.id + '.wav'">下载</a>
            <button class="btn sm danger" @click="delFile(f)">删除</button>
          </td>
        </tr></tbody></table>
      </div>
      <div class="grid-2">
        <div class="card">
          <h3>音色库（点击试听）</h3>
          <table><thead><tr><th>音色</th><th>类型</th><th>试听</th><th></th></tr></thead>
          <tbody><tr v-for="v in voices" :key="v.id">
            <td>{{ v.name }} <span v-if="v.id===defaultId" class="badge ok" style="margin-left:6px">默认</span></td>
            <td><span class="badge dim">{{ v.kind === 'builtin' ? '内置' : '克隆' }}</span></td>
            <td><audio v-if="v.has_file" :src="refUrl(v)" controls style="height:28px"></audio><span v-else class="muted">—</span></td>
            <td style="white-space:nowrap">
              <button class="btn sm" :disabled="v.id===defaultId" @click="setDefault(v)">{{ v.id===defaultId ? '已是默认' : '设为默认' }}</button>
              <button v-if="v.kind !== 'builtin'" class="btn sm danger" @click="remove(v)">删除</button>
            </td>
          </tr></tbody></table>
        </div>
        <div class="card">
          <h3>上传参考音频（语音克隆）</h3>
          <div class="field"><label>音色名</label><input v-model="vname" placeholder="例如：我的角色音色" /></div>
          <div class="field"><label>参考录音（10~30 秒，wav/flac/ogg/mp3）</label><input type="file" accept="audio/*" @change="onAudio" /></div>
          <button class="btn primary" :disabled="!audiodata" @click="uploadVoice">上传并克隆</button>
        </div>
      </div>
    </div>`,
    data() { return { voices: [], defaultId: 0, vname: '', audiodata: '', ttsText: '', ttsVoice: 0, speaking: false, speakUrl: '', speakFname: '', files: [] }; },
    computed: {
      defaultVoiceName() { const v = this.voices.find((x) => x.id === this.defaultId); return v ? v.name : ''; },
    },
    async mounted() { this.refresh(); },
    methods: {
      fmtTime,
      refUrl(v) { return authed('/api/tts/ref-audio/' + v.id); },
      fileAuthed(f) { return authed(f.url); },
      async refresh() {
        try { const v = await api('GET', '/tts/voices'); this.voices = v.voices; this.defaultId = v.default_voice_id; } catch (e) {}
        this.loadFiles();
      },
      async loadFiles() { try { const d = await api('GET', '/tts/files'); this.files = d.files; } catch (e) {} },
      async speak() {
        if (this.speaking) return;
        this.speaking = true; this.speakUrl = '';
        try {
          const d = await api('POST', '/tts/speak', { text: this.ttsText, voice_id: this.ttsVoice || undefined });
          this.speakUrl = authed(d.url);
          const ts = new Date(); const pad = (n) => String(n).padStart(2, '0');
          this.speakFname = `衍像语音_${ts.getFullYear()}${pad(ts.getMonth() + 1)}${pad(ts.getDate())}_${pad(ts.getHours())}${pad(ts.getMinutes())}.wav`;
          this.loadFiles();
        } catch (e) { alert(e.message); }
        finally { this.speaking = false; }
      },
      async delFile(f) {
        if (!confirm('删除这条配音及其文件？')) return;
        try { await api('DELETE', '/tts/file/' + f.id); this.loadFiles(); } catch (e) { alert(e.message); }
      },
      async setDefault(v) { try { await api('POST', '/tts/manage/default', { voice_id: v.id }); this.defaultId = v.id; this.refresh(); } catch (e) { alert(e.message); } },
      async remove(v) { if (!confirm('删除音色「' + v.name + '」？')) return; await api('DELETE', '/tts/manage/voice/' + v.id); this.refresh(); },
      onAudio(e) { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { this.audiodata = r.result; }; r.readAsDataURL(f); },
      async uploadVoice() { try { await api('POST', '/tts/manage/upload', { name: this.vname, data_base64: this.audiodata }); this.audiodata = ''; this.vname = ''; this.refresh(); } catch (e) { alert(e.message); } },
    },
  };

  // ---------- 视频剪辑（v1.0.19，衍像 × Concat） ----------
  const Edit = {
    template: `
    <div>
      <div class="page-head"><h2>视频剪辑</h2><div class="desc">衍像 × Concat —— 网页直接剪辑合成，取用你在衍像生成的图像、视频与配音素材</div></div>

      <div class="tabs" style="margin-bottom:14px">
        <button class="tab" :class="{active: mode==='studio'}" @click="mode='studio'">剪辑台（专业 · 多轨微调）</button>
        <button class="tab" :class="{active: mode==='quick'}" @click="mode='quick'">快速合成</button>
      </div>

      <EditStudio v-if="mode==='studio'" @done="onStudioDone" />

      <template v-if="mode==='quick'">
      <div class="card">
        <h3>安装 Concat（Windows）</h3>
        <div class="row" style="flex:none;flex-wrap:wrap;align-items:center">
          <span class="badge" :class="concat.available ? 'ok' : 'warn'">{{ concat.available ? '安装包已就绪' : '未托管' }}</span>
          <span v-if="concat.available" class="muted">v{{ concat.version }} · {{ bytes(concat.size) }} · 服务器直下（无需访问 GitHub）</span>
          <span v-else class="muted">本服务器尚未放置安装包，请用下方官方渠道下载</span>
        </div>
        <div class="row" style="flex:none;margin-top:12px;flex-wrap:wrap">
          <a v-if="concat.available" class="btn primary" :href="authed('/api/edit/concat/download')" :download="concat.file">下载安装包（setup.exe）</a>
          <a v-for="m in concat.mirrors || []" :key="m" class="btn sm" :href="m" target="_blank" rel="noopener">{{ m.includes('github') ? 'GitHub 发布页' : '官方网站' }}</a>
        </div>
        <div v-if="concat.sha256" class="muted mono" style="margin-top:10px;word-break:break-all;font-size:12px" title="校验安装包完整性">SHA256：{{ concat.sha256 }}</div>
        <div class="steps">
          <div><b>①</b> 点上方按钮下载 Concat 安装包（服务器内网直下）。</div>
          <div><b>②</b> 双击 setup.exe 安装；若 Windows SmartScreen 拦截（官方构建暂无付费签名），点「更多信息 → 仍要运行」。</div>
          <div><b>③</b> 首次启动 Concat 会跟随系统显示<b>简体中文</b>（也可在 Settings → Language 里切换）。</div>
          <div><b>④</b> 从下面素材框把你的图像 / 视频 / 配音下载下来，拖进 Concat 即可开始剪辑。</div>
        </div>
        <div class="feat-row">
          <span class="badge dim">无水印 · 免账号 · 全本地</span>
          <span class="badge dim">自动字幕</span>
          <span class="badge dim">文字转语音 + 音色克隆</span>
          <span class="badge dim">背景移除</span>
          <span class="badge dim">关键帧动画</span>
          <span class="badge dim">100+ 特效转场</span>
          <span class="badge dim">多轨剪辑</span>
          <span class="badge dim">最高 4K 导出</span>
        </div>
        <div class="muted" style="margin-top:12px">macOS / Linux / Android 用户请到官方网站下载对应安装包；Concat 采用 AGPL-3.0 开源协议，著作权归其作者所有（见【设置 → 致谢】）。</div>
      </div>

      <div class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <h3 style="margin:0">素材框 · 我的生成素材</h3>
          <div class="tabs" style="margin:0">
            <button class="tab" :class="{active: filter==='all'}" @click="filter='all'">全部 {{ items.length }}</button>
            <button class="tab" :class="{active: filter==='image'}" @click="filter='image'">图像 {{ counts.image }}</button>
            <button class="tab" :class="{active: filter==='video'}" @click="filter='video'">视频 {{ counts.video }}</button>
            <button class="tab" :class="{active: filter==='audio'}" @click="filter='audio'">音频 {{ counts.audio }}</button>
          </div>
        </div>
        <div class="muted" style="margin:8px 0 12px">来自「我的历史」的图像与视频（文生图 / 首尾视频 / H3），以及语音配音页用 MOSS 生成的配音文件。点缩略图预览；勾选素材即可在下方「网页快剪」直接合成，也可下载后拖进桌面版 Concat 深剪。</div>
        <div v-if="loading" class="muted">加载素材中…</div>
        <div v-else-if="!filtered.length" class="muted">还没有素材——先去文生图 / 生成视频 / 语音配音页产出内容。</div>
        <template v-else>
          <div v-if="mediaItems.length" class="asset-grid">
            <div v-for="(it, i) in mediaItems" :key="it.kind + it.name" class="asset-card" :class="{picked: isPicked(it)}">
              <div class="asset-thumb" @click="preview(it, i)">
                <img v-if="it.kind==='image'" :src="authed(it.url)" loading="lazy" />
                <video v-else :src="authed(it.url)" preload="metadata" muted @loadeddata="vidReady[it.kind+it.name]=true"></video>
                <span v-if="it.kind==='video' && !vidReady[it.kind+it.name]" class="vid-loading"><span class="spin"></span></span>
                <span class="asset-kind" :class="it.kind">{{ it.kind==='image' ? '图像' : '视频' }}</span>
              </div>
              <div class="asset-meta">
                <div class="ellip" :title="it.prompt">{{ it.prompt || it.name }}</div>
                <div class="row" style="flex:none;justify-content:space-between;align-items:center">
                  <label class="chk" style="gap:4px;font-size:12px" @click.stop><input type="checkbox" :checked="isPicked(it)" @change="toggle(it)" /> 快剪</label>
                  <a class="btn sm" :href="authed(it.url + '?dl=1')" :download="it.name">下载</a>
                </div>
              </div>
            </div>
          </div>
          <div v-if="audioItems.length" class="asset-audio">
            <div v-for="a in audioItems" :key="'a' + a.name" class="asset-audio-row" :class="{picked: isPicked(a)}">
              <label class="chk" style="flex:none;gap:4px;font-size:12px" @click.stop><input type="checkbox" :checked="isPicked(a)" @change="toggle(a)" /> 配音</label>
              <div class="ellip" style="flex:1;min-width:120px" :title="a.prompt">{{ a.prompt }}</div>
              <audio :src="authed(a.url)" controls preload="none" style="height:28px;min-width:220px;flex:none"></audio>
              <a class="btn sm" style="flex:none" :href="authed(a.url + '?dl=1')" :download="a.name">下载</a>
            </div>
          </div>
        </template>
      </div>

      <div class="card">
        <h3>网页快剪</h3>
        <div class="muted" style="margin-bottom:10px">把勾选的素材按顺序拼接成片（视频按原长、图像各 5 秒），可加片头标题与配音音轨——服务端由 Concat 引擎渲染，成片自动回到素材框。</div>
        <div v-if="!concat.engine || !concat.engine.installed" class="alert warn" style="margin-bottom:12px">
          服务器尚未安装 Concat 引擎：管理员先在上方下载安装包并在<b>服务器本机</b>安装一次（装完无需打开窗口），网页合成即开即用。
        </div>
        <div v-if="!picked.length" class="muted">还没勾选素材——到上方素材框点「快剪 / 配音」勾选。</div>
        <template v-else>
          <div class="muted" style="margin-bottom:6px">合成顺序（拖动调序，共 {{ picked.length }} 项）：</div>
          <div class="pick-strip">
            <div v-for="(p, i) in picked" :key="p.kind + p.name" class="pick-item" draggable="true"
              @dragstart="dragIdx = i" @dragover.prevent @drop="drop(i)">
              <span class="pick-no">{{ i + 1 }}</span>
              <span class="material-icons" style="font-size:16px">{{ p.kind==='audio' ? 'graphic_eq' : (p.kind==='image' ? 'image' : 'movie') }}</span>
              <span class="ellip" style="max-width:130px" :title="p.prompt || p.name">{{ p.prompt || p.name }}</span>
              <button class="pick-x" title="移除" @click="toggle(p)">×</button>
            </div>
          </div>
        </template>
        <div class="row" style="flex:none;flex-wrap:wrap;align-items:flex-end;margin-top:12px">
          <div class="field" style="min-width:260px;margin:0"><label>片头标题（可选，4 秒）</label><input v-model="renderTitle" maxlength="40" placeholder="例如：衍像作品集" /></div>
          <button class="btn primary" :disabled="!picked.length || rendering" @click="render">{{ rendering ? '已提交…' : '合成视频（' + picked.length + ' 项）' }}</button>
          <button v-if="picked.length" class="btn" @click="picked = []">清空所选</button>
        </div>
      </div>

      <div class="card">
        <h3>我的合成</h3>
        <div v-if="!jobs.length" class="muted">还没有合成任务。</div>
        <table v-else><thead><tr><th>#</th><th>标题</th><th>状态</th><th>用时</th><th>成片</th><th></th></tr></thead>
        <tbody><tr v-for="j in jobs" :key="j.id">
          <td>{{ j.id }}</td>
          <td class="ellip" style="max-width:200px" :title="j.title">{{ j.title || '-' }}</td>
          <td style="min-width:150px">
            <span class="badge" :class="j.status==='done'?'ok':(j.status==='failed'?'err':(j.status==='cancelled'?'dim':'warn'))">
              {{ {pending:'排队中',running:'合成中',cancelling:'取消中',done:'完成',failed:'失败',cancelled:'已取消'}[j.status] || j.status }}
            </span>
            <div v-if="j.status==='running' || j.status==='cancelling'" class="progress" style="margin-top:4px"><div :style="{width: (j.progress_pct||0) + '%'}"></div></div>
            <div class="muted" style="font-size:12px;margin-top:2px">{{ j.progress }} {{ j.progress_pct ? '· ' + j.progress_pct + '%' : '' }}</div>
          </td>
          <td class="muted">{{ j.duration_ms ? Math.round(j.duration_ms / 1000) + 's' : '-' }}</td>
          <td style="white-space:nowrap">
            <a v-if="j.output_url" class="btn sm" :href="authed(j.output_url + '?dl=1')" :download="j.output_name">下载</a>
            <span v-else class="muted">—</span>
          </td>
          <td><button v-if="['pending','running','cancelling'].includes(j.status)" class="btn sm danger" @click="cancelJob(j)">停止</button></td>
        </tr></tbody></table>
      </div>
      </template>
    </div>`,
    data() { return { mode: 'studio', concat: { available: false, version: '', size: 0, file: '', sha256: '', mirrors: [], engine: { installed: false } }, items: [], counts: { image: 0, video: 0, audio: 0 }, filter: 'all', loading: true, picked: [], dragIdx: -1, renderTitle: '', rendering: false, jobs: [], jobTimer: null, vidReady: {} }; },
    computed: {
      filtered() { return this.filter === 'all' ? this.items : this.items.filter((i) => i.kind === this.filter); },
      mediaItems() { return this.filtered.filter((i) => i.kind !== 'audio'); },
      audioItems() { return this.filtered.filter((i) => i.kind === 'audio'); },
    },
    async mounted() {
      try { this.concat = await api('GET', '/edit/concat/status'); } catch (e) {}
      await this.reload();
      this.loading = false;
      this.loadJobs();
      this.jobTimer = setInterval(() => this.loadJobs(), 2500);
    },
    unmounted() { if (this.jobTimer) clearInterval(this.jobTimer); },
    methods: {
      bytes, fmtTime, authed,
      async reload() { try { const d = await api('GET', '/edit/assets'); this.items = d.items; this.counts = d.counts; } catch (e) {} },
      isPicked(it) { return this.picked.some((p) => p.kind === it.kind && p.name === it.name); },
      toggle(it) {
        if (this.isPicked(it)) this.picked = this.picked.filter((p) => !(p.kind === it.kind && p.name === it.name));
        else this.picked.push({ kind: it.kind, name: it.name, prompt: it.prompt });
      },
      drop(i) {
        if (this.dragIdx < 0 || this.dragIdx === i) return;
        const arr = this.picked.slice();
        const [m] = arr.splice(this.dragIdx, 1);
        arr.splice(i, 0, m);
        this.picked = arr; this.dragIdx = -1;
      },
      async loadJobs() {
        try {
          const d = await api('GET', '/edit/jobs');
          this.jobs = d.jobs;
          if (this.jobs.some((j) => ['pending', 'running', 'cancelling'].includes(j.status))) this.reload(); // 完成时成片进素材框
        } catch (e) {}
      },
      async render() {
        if (!this.picked.length || this.rendering) return;
        this.rendering = true;
        try {
          await api('POST', '/edit/render', { title: this.renderTitle, items: this.picked.map((p) => ({ kind: p.kind, name: p.name })) });
          this.renderTitle = '';
          this.loadJobs();
        } catch (e) { alert(e.message); }
        finally { this.rendering = false; }
      },
      async cancelJob(j) {
        if (!confirm('停止合成任务 #' + j.id + '？')) return;
        try { await api('POST', '/edit/render/' + j.id + '/cancel', {}); this.loadJobs(); } catch (e) { alert(e.message); }
      },
      preview(it, idx) {
        const list = this.mediaItems.map((x) => ({ kind: x.kind, url: this.authed(x.url), title: x.prompt || x.name, sub: fmtTime(x.created_at) }));
        openViewer(list, idx);
      },
      onStudioDone() { this.reload(); this.loadJobs(); }, // 剪辑台导出完成 → 成片回流素材框 + 任务列表
    },
  };

  // ---------- 剪辑台（v1.0.20：按 Concat 结构的网页专业剪辑） ----------
  // 素材库 / 真实帧预览 / 属性检查器 / 多轨时间线。引擎在服务端无头跑（每用户一个常驻会话，
  // 15 分钟空闲自动保存关闭），这里只是它的中文驾驶舱。
  // v1.0.21：素材库九页签（媒体/音频/文本/贴纸/转场/效果/滤镜/调节/模板）——全部走引擎真能力：
  // 贴纸=addShapeClip（ShapeStyle，尺寸=画面高度比例）、转场=addTransitionClip、
  // 效果/滤镜/调节/音效=addLayerClip（调节=concat.adjust 层，强度=不透明度）。
  // TextStyle/ShapeStyle 字段均为 serde camelCase，且部分字段缺省可省（引擎自带 default）。
  const LIB_TABS = [
    { id: 'media', icon: 'perm_media', label: '媒体' },
    { id: 'audio', icon: 'graphic_eq', label: '音频' },
    { id: 'text', icon: 'title', label: '文本' },
    { id: 'sticker', icon: 'interests', label: '贴纸' },
    { id: 'transition', icon: 'animation', label: '转场' },
    { id: 'effect', icon: 'auto_awesome', label: '效果' },
    { id: 'filter', icon: 'photo_filter', label: '滤镜' },
    { id: 'adjust', icon: 'tune', label: '调节' },
    { id: 'template', icon: 'dashboard_customize', label: '模板' },
  ];
  // 文字样式预设：数值全部是「画面高度的比例」（TextStyle 契约），不是像素
  const TEXT_PRESETS = [
    { id: 'title', label: '主标题', sample: '主标题', content: '主标题文字', style: { fontSize: 0.11, fontWeight: 800, color: '#ffffff', shadow: true }, preview: { fontSize: '15px', fontWeight: '800' } },
    { id: 'sub', label: '副标题', sample: '副标题', content: '副标题文字', style: { fontSize: 0.06, fontWeight: 500, color: '#f0f0f0', shadow: true }, preview: { fontSize: '12px', fontWeight: '500', color: '#c8c8c8' } },
    { id: 'caption', label: '字幕条', sample: '字幕内容', content: '字幕内容', style: { fontSize: 0.045, color: '#ffffff', background: '#000000AA', backgroundRadius: 0.012, backgroundPaddingX: 0.02, backgroundPaddingY: 0.012 }, offsetY: 0.32, preview: { fontSize: '11px', background: '#000000AA', padding: '2px 8px', borderRadius: '4px' } },
    { id: 'gold', label: '金色大字', sample: '金色', content: '金色大字', style: { fontSize: 0.13, fontWeight: 900, color: '#FFD700', shadow: true }, preview: { fontSize: '16px', fontWeight: '900', color: '#FFD700' } },
    { id: 'credit', label: '片尾字幕', sample: '出品 · 衍像', content: '出品 · 衍像', style: { fontSize: 0.05, color: '#d0d0d0', shadow: true }, preview: { fontSize: '11px', color: '#a8a8a8' } },
  ];
  // 形状贴纸：style 片段按 ShapeStyle 契约（fill/width 加色与大小时注入）。
  // 引擎 0.2.9 实测支持 7 种：square/circle/triangle/parallelogram/trrapezoid/line/arrow
  // （star/heart/polygon 是引擎更高版本的形状，发了也会退化成 square，所以不列）
  const STICKER_COLORS = ['#FFD700', '#ffffff', '#ef4444', '#3b82f6', '#22c55e', '#ec4899', '#000000'];
  const STICKERS = [
    { id: 'circle', label: '圆形', path: 'M12 3a9 9 0 100 18 9 9 0 000-18z' },
    { id: 'square', label: '方形', path: 'M4 4h16v16H4z' },
    { id: 'rounded', label: '圆角块', path: 'M5 5h14a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V7a2 2 0 012-2z' },
    { id: 'triangle', label: '三角', path: 'M12 3l9 18H3z' },
    { id: 'pill', label: '胶囊', path: 'M8 8h8a4 4 0 010 8H8a4 4 0 010-8z' },
    { id: 'parallelogram', label: '斜块', path: 'M7 5h13l-3 14H4z' },
    { id: 'trapezoid', label: '梯形', path: 'M8 5h8l4 14H4z' },
    { id: 'arrow', label: '箭头', path: 'M4 11h12l-4-4 1.5-1.5L20 12l-6.5 6.5L12 17l4-4H4z' },
    { id: 'line', label: '线条', path: 'M3 11h18v2H3z' },
  ];
  const STICKER_STYLE = {
    rounded: { kind: 'square', cornerRadius: 0.35 },
    pill: { kind: 'square', height: 0.14, cornerRadius: 1.0 },
  };
  // 引擎效果目录中文化（0.2.9 全 128 条；引擎新增未收录的条目回退英文原名）
  const EFF_ZH = {
    // 滤镜（filter · 57）
    'concat.adjust': '调节面板', 'concat.autumn': '秋日', 'concat.bleach-bypass': '漂白旁路', 'concat.bronze': '青铜',
    'concat.classic-chrome': '经典铬黄', 'concat.clean': '清透', 'concat.cloudless-sky': '万里晴空', 'concat.contrast-pop': '高对比',
    'concat.cool': '冷色', 'concat.cool-blue': '冷蓝', 'concat.cyberpunk': '赛博朋克', 'concat.daydream': '白日梦',
    'concat.delicious': '美味', 'concat.digicam': '数码相机', 'concat.dreamy': '梦幻', 'concat.fair': '白皙',
    'concat.falling-dust': '落尘', 'concat.film': '电影胶片', 'concat.fresh': '清新', 'concat.golden-hour': '黄金时刻',
    'concat.high-contrast-mono': '高对比黑白', 'concat.ivory': '象牙白', 'concat.lagoon': '环礁湖蓝', 'concat.landscape-pop': '风景鲜艳',
    'concat.marquee': '跑马灯', 'concat.matcha': '抹茶', 'concat.midnight': '午夜', 'concat.milk': '牛奶白',
    'concat.mono': '黑白', 'concat.moody': '阴郁', 'concat.natural': '自然', 'concat.neon': '霓虹',
    'concat.night': '夜色', 'concat.noir': '黑色电影', 'concat.peach': '蜜桃', 'concat.pink-fuzz': '粉雾',
    'concat.polaroid': '拍立得', 'concat.rain': '雨天', 'concat.retro-70s': '70 年代复古', 'concat.retro-cartoon': '复古卡通',
    'concat.rosy': '玫瑰粉', 'concat.sage': '鼠尾草绿', 'concat.sci-fi': '科幻', 'concat.silver': '银盐黑白',
    'concat.soft-light': '柔光', 'concat.spooky': '惊悚', 'concat.super-8': '超 8 毫米', 'concat.teal-orange': '青橙大片',
    'concat.tropical': '热带', 'concat.umber': '棕褐', 'concat.vaporwave': '蒸汽波', 'concat.vhs': '录像带',
    'concat.vibrance': '自然饱和', 'concat.vintage': '怀旧', 'concat.vivid': '鲜艳', 'concat.warm': '暖色',
    'concat.winter-cool': '冬日冷调',
    // 音频（audio · 25）
    'concat.bass': '低音增强', 'concat.bright': '明亮', 'concat.cathedral': '大教堂', 'concat.chipmunk': '花栗鼠音',
    'concat.deep': '低沉', 'concat.denoise': '降噪', 'concat.distorted': '失真', 'concat.echo': '回声',
    'concat.enhance-voice': '人声增强', 'concat.hall': '大厅混响', 'concat.lofi': '复古低保真', 'concat.loudness': '响度均衡',
    'concat.megaphone': '扩音喇叭', 'concat.pitch': '音调升降', 'concat.plate': '板式混响', 'concat.radio': '收音机',
    'concat.robot': '机器人音', 'concat.room': '房间混响', 'concat.stadium': '体育场', 'concat.sweet': '甜嗓',
    'concat.telephone': '电话音', 'concat.treble': '高音增强', 'concat.underwater': '水下音', 'concat.vinyl': '黑胶唱片',
    'concat.whisper': '气声耳语',
    // 效果（effect · 24）
    'concat.bloom-pulse': '呼吸光晕', 'concat.chroma-key': '色度抠像', 'concat.chromatic-aberration': '色差', 'concat.color-wheels': '色轮',
    'concat.contrast': '对比度', 'concat.corona': '光冕', 'concat.curves': '曲线', 'concat.exposure': '曝光',
    'concat.film-grain': '胶片颗粒', 'concat.fisheye': '鱼眼', 'concat.gaussian-blur': '高斯模糊', 'concat.glow': '辉光',
    'concat.halation': '光晕溢出', 'concat.halftone': '半调网点', 'concat.luma-key': '亮度抠像', 'concat.motion-blur': '动态模糊',
    'concat.pixelate': '像素化', 'concat.posterize': '色调分离', 'concat.remove-black': '去黑背景', 'concat.saturation': '饱和度',
    'concat.sharpen': '锐化', 'concat.vignette': '暗角', 'concat.white-balance': '白平衡', 'concat.zoom-blur': '变焦模糊',
    // 转场（transition · 22）
    'concat.blur-dissolve': '模糊溶解', 'concat.clock-wipe': '时钟擦除', 'concat.cube': '立方体', 'concat.dissolve': '溶解',
    'concat.fade-black': '淡入黑场', 'concat.fade-white': '淡入白场', 'concat.film-burn': '胶片烧灼', 'concat.glitch-transition': '故障切换',
    'concat.glitch-warp': '故障扭曲', 'concat.iris': '光圈展开', 'concat.light-leak-flash': '漏光闪烁', 'concat.light-leak-transition': '漏光',
    'concat.linear-wipe': '线性擦除', 'concat.push': '推移', 'concat.rgb-split-wipe': 'RGB 分离', 'concat.shape-wipe': '形状擦除',
    'concat.slide': '滑动', 'concat.spin': '旋转', 'concat.swirl': '旋涡', 'concat.whip-pan': '甩镜头',
    'concat.zoom-blur-transition': '变焦模糊', 'concat.zoom-transition': '变焦推近',
  };
  const CAT_ZH = {
    Adjust: '调节', Scenery: '风景', Cinematic: '电影感', Retro: '复古', Film: '胶片', Everyday: '日常', Color: '色彩',
    Food: '美食', Vibe: '氛围', Portrait: '人像', 'Black & White': '黑白', Stylised: '风格化', Stylize: '风格化',
    Tone: '音色', Voice: '人声', Space: '空间感', Clean: '清晰', Light: '光效', Cutout: '抠像', Distort: '变形',
    Blur: '模糊', Basic: '基础', Dissolve: '溶解', Wipe: '擦除', Glitch: '故障', Slide: '滑动', Spin: '旋转', Zoom: '变焦',
  };
  const EditStudio = {
    template: `
    <div class="studio">
      <div v-if="!open" class="card">
        <h3>剪辑台</h3>
        <div v-if="opening" class="muted" style="margin:8px 0">正在启动引擎并载入工程…（首次约几秒）</div>
        <template v-else>
          <div class="alert warn" style="margin:8px 0">未能打开剪辑台：{{ openError || '未知原因' }}</div>
          <div class="row" style="flex:none;flex-wrap:wrap">
            <button class="btn primary" @click="autoOpen()">重试</button>
            <span class="muted">若提示未安装 Concat，请管理员在服务器安装引擎（装完无需打开窗口）。</span>
          </div>
        </template>
      </div>

      <template v-else>
        <div class="card st-bar">
          <div class="row" style="flex:none;gap:6px;flex-wrap:wrap;align-items:center">
            <button class="btn sm" :disabled="opening" @click="newProject" title="保存当前工程并新建空工程">✚ 新建工程</button>
            <span class="st-sep"></span>
            <button class="btn sm" :disabled="saving" @click="save">{{ saving ? '保存中…' : '💾 保存' }}</button>
            <button class="btn primary" :disabled="exporting" @click="doExport">{{ exporting ? '导出中 ' + (exportJob ? exportJob.progress_pct + '%' : '') : '⬇ 导出视频' }}</button>
            <span style="flex:1"></span>
            <span class="muted" style="font-size:12px">播放 / 分割 / 删除等剪辑操作在时间线上方</span>
          </div>
          <div v-if="exportJob && exportJob.status==='done'" class="row" style="flex:none;margin-top:8px;gap:10px;align-items:center">
            <span class="badge ok">成片已生成</span>
            <a class="btn sm" :href="authed('/api/edit/file/video/' + encodeURIComponent(exportJob.output_name) + '?dl=1')" :download="exportJob.output_name">下载 {{ exportJob.output_name }}</a>
            <span class="muted">用时 {{ Math.round((exportJob.duration_ms||0)/1000) }}s · 已回到素材库可二剪</span>
          </div>
        </div>

        <div class="studio-main">
          <div class="card st-bin">
            <div class="lib-bar">
              <button v-for="t in LIB_TABS" :key="t.id" class="lib-tab" :class="{active: binTab===t.id}" @click="binTab=t.id; loadEffects()">
                <span class="material-icons">{{ t.icon }}</span><span>{{ t.label }}</span>
              </button>
            </div>
            <div class="st-bin-list">
              <!-- 媒体 -->
              <template v-if="binTab==='media'">
                <div class="lib-sub" style="margin-bottom:6px">
                  <span class="muted" style="font-size:12px">小预览图 · 点 ＋ 上轨</span>
                  <button class="btn sm" :disabled="importing" :title="'从本机导入视频/图片/音频（≤50MB），导入后即可上轨剪辑'" @click="pickImport">{{ importing ? '导入中…' : '⬆ 导入' }}</button>
                  <button class="btn sm" title="从本系统生成的历史视频/图片中导入" @click="openHistory('media')">🕘 从历史导入</button>
                  <input ref="fileInput" type="file" accept="video/mp4,video/webm,video/quicktime,image/png,image/jpeg,image/webp,audio/wav,audio/mpeg,audio/flac,audio/ogg" multiple style="display:none" @change="importFiles"/>
                </div>
                <!-- 缩略图墙：只显示视频/图片缩略图（无文字行），音频在「音频」页签 -->
                <div class="st-thumb-grid">
                  <div v-for="a in assets.filter(x=>x.kind!=='audio')" :key="a.kind+a.name" class="st-thumb-tile" :class="{inlib: inBin(a)}"
                          :title="(a.prompt || a.name) + (inBin(a) ? '（已在素材库）' : '')" @click="addToTimeline(a)">
                    <img v-if="a.kind==='image'" class="st-thumb" :src="authed(a.url)" loading="lazy" alt=""/>
                    <video v-else class="st-thumb" :src="authed(a.url)" muted playsinline preload="metadata" @loadeddata="vidReady[a.kind+a.name]=true"></video>
                    <span v-if="a.kind==='video' && !vidReady[a.kind+a.name]" class="vid-loading"><span class="spin"></span></span>
                    <span v-if="inBin(a)" class="badge ok tile-flag" title="已在素材库">✓</span>
                    <button class="tile-del" title="删除素材" @click.stop="delAsset(a)">✕</button>
                  </div>
                </div>
                <div v-if="!assets.some(x=>x.kind!=='audio')" class="muted">还没有视频 / 图片素材——点上方「⬆ 导入」上传本机视频，或去文生图 / 生成视频页产出内容。</div>
              </template>

              <!-- 音频：配音素材 + 引擎音效包 -->
              <template v-else-if="binTab==='audio'">
                <div class="lib-sub" style="margin-bottom:6px">
                  <span class="muted" style="font-size:12px">我的配音 · 点 ＋ 上轨</span>
                  <button class="btn sm" title="从本系统的历史配音中导入" @click="openHistory('audio')">🕘 从历史导入</button>
                </div>
                <div v-for="a in assets.filter(x=>x.kind==='audio')" :key="'a'+a.name" class="st-bin-item" :class="{inlib: inBin(a)}">
                  <span class="material-icons" style="font-size:16px">graphic_eq</span>
                  <span class="ellip" style="flex:1" :title="a.prompt || a.name">{{ a.prompt || a.name }}</span>
                  <button class="btn sm" :disabled="binBusy" @click="addToTimeline(a)">＋</button>
                  <button class="btn sm danger" title="删除素材" @click="delAsset(a)">✕</button>
                </div>
                <div v-if="!assets.some(x=>x.kind==='audio')" class="muted" style="font-size:12px">还没有配音——去「语音配音」页生成。</div>
                <div class="lib-sub">音效（作用于整段混音 · 点按铺到播放头）</div>
                <div class="lib-grid">
                  <button v-for="e in effectsOf('audio')" :key="e.id" class="lib-card" @click="addEffectCard(e)" :title="(e.description || e.name) + '（' + effName(e) + '）'">
                    <span class="material-icons">{{ e.category==='Voice' ? 'record_voice_over' : (e.category==='Space' ? 'spatial_audio' : 'equalizer') }}</span>
                    <span class="ellip">{{ effName(e) }}</span><span class="badge dim" style="font-size:10px">{{ catName(e) }}</span>
                  </button>
                </div>
              </template>

              <!-- 文本 -->
              <template v-else-if="binTab==='text'">
                <div class="lib-sub">文字样式（点按加到播放头，选中后可改内容）</div>
                <div class="lib-grid">
                  <button v-for="p in TEXT_PRESETS" :key="p.id" class="lib-card text-card" @click="addTextPreset(p)">
                    <span class="text-preview" :style="p.preview">{{ p.sample }}</span>
                    <span class="lib-name">{{ p.label }}</span>
                  </button>
                </div>
              </template>

              <!-- 贴纸（形状） -->
              <template v-else-if="binTab==='sticker'">
                <div class="lib-sub">形状贴纸 · 颜色
                  <span class="swatches">
                    <button v-for="c in STICKER_COLORS" :key="c" class="swatch" :class="{on: stickerColor===c}" :style="{background:c}" @click="stickerColor=c"></button>
                  </span>
                </div>
                <div class="lib-sub" style="margin-top:2px">大小
                  <span class="sizes">
                    <button v-for="s in [[0.2,'小'],[0.35,'中'],[0.55,'大']]" :key="s[0]" class="btn sm" :class="{primary: stickerSize===s[0]}" @click="stickerSize=s[0]">{{ s[1] }}</button>
                  </span>
                </div>
                <div class="lib-grid">
                  <button v-for="s in STICKERS" :key="s.id" class="lib-card sticker-card" @click="addSticker(s)" :title="s.label">
                    <svg viewBox="0 0 24 24" class="shape-ic"><path :d="s.path" :fill="stickerColor"/></svg>
                    <span class="lib-name">{{ s.label }}</span>
                  </button>
                </div>
              </template>

              <!-- 转场 / 效果 / 滤镜 / 调节 -->
              <template v-else-if="binTab==='transition' || binTab==='effect' || binTab==='filter' || binTab==='adjust'">
                <div v-if="binTab==='adjust'" class="muted" style="font-size:12px;margin-bottom:6px">调节层：曝光 / 亮度 / 对比度 / 饱和度 / 色温等，铺在画面上方作用其下所有片段；强度＝选中后调「不透明度」。</div>
                <div v-else class="muted" style="font-size:12px;margin-bottom:6px">{{ {transition:'转场铺在切换点上（两段画面之间），对下方所有画面生效；时长默认 0.8s。', effect:'效果层作用于其下所有片段（发光 / 模糊 / 抠像…）；选中后调「不透明度」控制强度。', filter:'滤镜直接改变画面风格（电影 / 复古 / 黑白…），铺到播放头；选中后调「不透明度」控制浓度。'}[binTab] }}</div>
                <div class="lib-grid">
                  <button v-for="e in effectsOf(binTab)" :key="e.id" class="lib-card" @click="addEffectCard(e)" :title="(e.description || e.name) + '（' + effName(e) + '）'">
                    <span class="material-icons">{{ binTab==='transition' ? 'animation' : (binTab==='adjust' ? 'tune' : 'auto_awesome') }}</span>
                    <span class="ellip">{{ effName(e) }}</span>
                    <span class="badge dim" style="font-size:10px">{{ catName(e) }}</span>
                  </button>
                </div>
                <div v-if="!effects" class="muted">效果目录加载中…</div>
                <div v-else-if="!effectsOf(binTab).length" class="muted">这一类暂无条目。</div>
              </template>

              <!-- 模板 -->
              <template v-else-if="binTab==='template'">
                <div class="muted" style="font-size:13px;line-height:1.7">模板库当前为空。<br/>在 Concat 桌面版里把工程保存为模板后，这里会列出并可一键套用（引擎已支持 template.instantiate）。</div>
              </template>
            </div>
          </div>

          <div class="st-right">
          <div class="card st-preview">
            <div class="st-frame" :class="{zoomable: preview}" :title="preview ? '点击放大预览' : ''" @click="preview && (zoomPreview = true)">
              <img v-if="preview" :src="preview" alt="预览帧" />
              <div v-else class="muted" style="padding:40px 16px;text-align:center">{{ previewBusy ? '渲染真实帧中…' : '拖动时间线标尺或点「▶ 预览」查看真实画面（标题 / 变换 / 特效全部合成）' }}</div>
            </div>
            <div class="st-preview-meta muted">
              <span>{{ state.project.width }}×{{ state.project.height }} · {{ state.project.fps }}fps</span>
              <span>时间线 {{ fmtS(tlDuration) }} · {{ (state.timeline.clips||[]).length }} 个片段</span>
              <span class="mono">rev {{ state.rev }}</span>
            </div>
          </div>

          <div class="card st-insp">
            <h4>属性{{ selected ? '' : ' · 未选中片段' }}</h4>
            <template v-if="selected">
              <div class="st-field"><span>类型</span><span class="badge dim">{{ {video:'视频',image:'图像',audio:'音频',text:'文字',shape:'贴纸',transition:'转场',layer:'效果层',soundLayer:'音效层'}[selected.kind] || selected.kind }}</span></div>
              <div class="st-field"><span>位置</span><span class="mono">{{ fmtS(selected.start) }}</span></div>
              <div class="st-field"><span>时长</span><span class="mono">{{ fmtS(selected.duration) }}</span></div>
              <div v-if="['layer','soundLayer','transition'].includes(selected.kind)" class="st-field"><span>作用效果</span><span class="ellip" style="flex:1;text-align:right" :title="((selected.effects||[]).concat(selected.audioFilters||[])).join(', ')">{{ ((selected.effects||[]).concat(selected.audioFilters||[])).map(effIdLabel).join('、') || '-' }}</span></div>
              <div v-if="['layer','soundLayer','transition'].includes(selected.kind)" class="muted" style="font-size:12px;margin:4px 0">层的强度＝「不透明度」：100% 全量生效，调低即减淡。</div>

              <template v-if="selected.kind==='text'">
                <div class="st-field col"><span>文字内容</span>
                  <textarea v-model="titleDraft" rows="2" maxlength="120" style="width:100%"></textarea>
                  <button class="btn sm" style="margin-top:4px" @click="applyTitle">应用文字</button>
                </div>
              </template>

              <template v-if="selected.kind!=='text'">
                <div class="st-field"><span>不透明度 {{ Math.round((selected.opacity ?? 1)*100) }}%</span>
                  <input type="range" min="0" max="1" step="0.05" :value="selected.opacity ?? 1" @change="patch({opacity: Number($event.target.value)})" /></div>
                <div v-if="['video','image','shape'].includes(selected.kind)" class="st-field col"><span>画面（缩放 / 位置 / 旋转）</span>
                  <div class="st-grid2">
                    <label>缩放 {{ (tfVal('scale') ?? 1).toFixed(2) }}×</label><input type="range" min="0.2" max="4" step="0.05" :value="tfVal('scale') ?? 1" @change="transform({scale: Number($event.target.value)})" />
                    <label>水平 ±3</label><input type="number" step="0.05" min="-3" max="3" :value="tfVal('offsetX') ?? 0" @change="transform({offsetX: Number($event.target.value)})" />
                    <label>垂直 ±3</label><input type="number" step="0.05" min="-3" max="3" :value="tfVal('offsetY') ?? 0" @change="transform({offsetY: Number($event.target.value)})" />
                    <label>旋转°</label><input type="number" step="5" min="-180" max="180" :value="tfVal('rotation') ?? 0" @change="transform({rotation: Number($event.target.value)})" />
                  </div>
                  <div class="row" style="flex:none;gap:6px;margin-top:6px">
                    <button class="btn sm" @click="frame('fit')">适配（完整显示）</button>
                    <button class="btn sm" @click="frame('fill')">填充（裁掉溢出）</button>
                    <label class="chk" style="font-size:12px"><input type="checkbox" :checked="!!selected.flipH" @change="patch({flipH: $event.target.checked})" /> 水平翻转</label>
                    <label class="chk" style="font-size:12px"><input type="checkbox" :checked="!!selected.flipV" @change="patch({flipV: $event.target.checked})" /> 垂直翻转</label>
                  </div>
                </div>

                <div v-if="['video','image','audio'].includes(selected.kind)" class="st-field"><span>速度 {{ (selected.speed ?? 1).toFixed(2) }}×</span>
                  <input type="range" min="0.25" max="4" step="0.05" :value="selected.speed ?? 1" @change="cmd('setClipSpeed', { clipId: selected.id, speed: Number($event.target.value), ripple })" /></div>

                <template v-if="hasAudioTrack">
                  <div class="st-field"><span>音量 {{ Math.round((selected.volume ?? 1)*100) }}%</span>
                    <input type="range" min="0" max="2" step="0.05" :value="selected.volume ?? 1" @change="patch({volume: Number($event.target.value)})" /></div>
                  <div class="st-grid2">
                    <label>淡入 s</label><input type="number" step="0.1" min="0" :value="selected.fadeIn ?? 0" @change="patch({fadeIn: Number($event.target.value)})" />
                    <label>淡出 s</label><input type="number" step="0.1" min="0" :value="selected.fadeOut ?? 0" @change="patch({fadeOut: Number($event.target.value)})" />
                  </div>
                  <div class="row" style="flex:none;gap:8px;margin-top:4px">
                    <label class="chk" style="font-size:12px"><input type="checkbox" :checked="!!selected.muted" @change="patch({muted: $event.target.checked})" /> 静音</label>
                    <button v-if="selected.kind==='video'" class="btn sm" @click="cmd('detachAudio', { clipId: selected.id })" title="把视频里的声音抽成独立音频片段（音轨分离）">分离音频</button>
                  </div>
                </template>
              </template>
            </template>
            <div v-else class="muted" style="font-size:13px">点时间线上的片段查看属性；拖片段主体移动、拖左右边缘修剪。</div>
          </div>
          </div>
        </div>

        <div class="card st-timeline">
          <div class="row" style="flex:none;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap">
            <h4 style="margin:0">时间线</h4>
            <span class="st-sep"></span>
            <button class="btn sm" @click="seek(0)" title="回到开头">⏮</button>
            <button class="btn sm primary" @click="togglePlay">{{ playing ? '⏸ 暂停' : '▶ 预览' }}</button>
            <span class="mono" style="font-size:13px">{{ fmtS(playhead) }} / {{ fmtS(tlDuration) }}</span>
            <span class="st-sep"></span>
            <button class="btn sm" @click="addTrack" title="在顶部加一条轨道">＋ 轨道</button>
            <button class="btn sm" :disabled="!state.canUndo" @click="undo(false)" title="撤销上一步">↩ 撤回</button>
            <button class="btn sm" :disabled="!state.canRedo" @click="undo(true)" title="重做">↪ 重复</button>
            <button class="btn sm" :disabled="!selected" @click="duplicateSel" title="复制选中的片段到播放头">⧉ 复制</button>
            <span class="st-sep"></span>
            <button class="btn sm" :disabled="!selected" @click="splitSel">✂ 分割</button>
            <button class="btn sm danger" :disabled="!selected" @click="removeSel">🗑 删除</button>
            <label class="chk" style="font-size:12px"><input type="checkbox" v-model="ripple" /> 磁吸</label>
            <span style="flex:1"></span>
            <span class="muted" style="font-size:12px">缩放</span>
            <input type="range" min="30" max="200" step="10" v-model.number="pps" style="width:120px" />
          </div>
          <div class="tl-scroll" ref="tlScroll">
            <div class="tl-inner" :style="{width: tlWidth + 'px'}">
              <div class="tl-ruler" @mousedown.prevent="rulerDown($event)">
                <span v-for="s in rulerTicks" :key="s" class="tl-tick" :style="{left: (s*pps + tlHead) + 'px'}">{{ s }}s</span>
              </div>
              <div class="tl-rows" @mousedown="laneDown($event)">
                <div v-for="tr in tracksTopDown" :key="tr.id" class="tl-row">
                  <div class="tl-trackhead">
                    <span>轨 {{ tr.index + 1 }}</span>
                    <button class="tl-flag" :class="{off: tr.muted}" title="静音" @click="trackFlag(tr, 'muted', !tr.muted)">🔊</button>
                    <button class="tl-flag" :class="{off: tr.hidden}" title="隐藏画面" @click="trackFlag(tr, 'visible', tr.hidden)">👁</button>
                  </div>
                  <div class="tl-lane" :data-track="tr.id">
                    <div v-for="c in clipsOn(tr.id)" :key="c.id" class="tl-clip" :class="[c.kind, {sel: selectedId === c.id}]"
                         :style="clipStyle(c)" :title="clipLabel(c)"
                         @mousedown.stop.prevent="clipDown($event, c, 'move')">
                      <span class="tl-edge l" @mousedown.stop.prevent="clipDown($event, c, 'l')" title="修剪头"></span>
                      <span class="tl-clip-label">{{ clipLabel(c) }}</span>
                      <span class="tl-edge r" @mousedown.stop.prevent="clipDown($event, c, 'r')" title="修剪尾"></span>
                    </div>
                  </div>
                </div>
              </div>
              <div class="tl-playhead" :style="{left: (playhead * pps + tlHead) + 'px'}"></div>
            </div>
          </div>
        </div>
      </template>

      <!-- 放大预览（点击预览画面打开，点任意处 / Esc 关闭） -->
      <div v-if="zoomPreview" class="st-zoom" @click="zoomPreview=false">
        <img v-if="preview" :src="preview" alt="放大预览"/>
        <div class="st-zoom-tip">{{ fmtS(playhead) }} · 点击任意处关闭（Esc）</div>
      </div>

      <!-- 从历史导入（本系统生成的视频/图片/配音 → 素材库） -->
      <div v-if="historyPick" class="st-zoom" @click.self="historyPick=false">
        <div class="card st-history">
          <h4 style="margin:0 0 8px">从历史导入{{ histKind === 'audio' ? '（配音）' : '（生成的视频 / 图片）' }}</h4>
          <div class="st-hist-list">
            <div v-for="a in historyItems" :key="a.kind+a.name" class="st-bin-item" :class="{inlib: inBin(a)}">
              <img v-if="a.kind==='image'" class="st-thumb" :src="authed(a.url)" loading="lazy" alt=""/>
              <video v-else-if="a.kind==='video'" class="st-thumb" :src="authed(a.url)" muted playsinline preload="metadata"></video>
              <span v-else class="material-icons" style="font-size:16px;flex:none">graphic_eq</span>
              <span class="ellip" style="flex:1" :title="a.prompt || a.name">{{ a.prompt || a.name }}</span>
              <span class="badge dim" style="font-size:11px">{{ {image:'图',video:'视频',audio:'音'}[a.kind] }}</span>
              <button v-if="!inBin(a)" class="btn sm" :disabled="histBusy===a.name" @click="importHistory(a)">{{ histBusy===a.name ? '导入中…' : '导入' }}</button>
              <span v-else class="badge ok">已入库</span>
            </div>
            <div v-if="!historyItems.length" class="muted" style="padding:16px 0;text-align:center">历史里还没有{{ histKind === 'audio' ? '配音' : '生成的视频 / 图片' }}。</div>
          </div>
          <div class="row" style="flex:none;margin-top:10px">
            <span class="muted" style="font-size:12px">导入后素材进入左侧素材库，点 ＋ 即可上轨。</span>
            <span style="flex:1"></span>
            <button class="btn sm" @click="historyPick=false">关闭（Esc）</button>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return {
        open: false, state: null, projects: [], opening: false, openError: '',
        assets: [], binBusy: false, importing: false, zoomPreview: false, vidReady: {},
        historyPick: false, histKind: 'media', histBusy: '',
        binTab: 'media', effects: null,
        stickerColor: '#FFD700', stickerSize: 0.35,
        LIB_TABS, TEXT_PRESETS, STICKERS, STICKER_COLORS, // 常量目录（模板可见）
        pps: 60, tlHead: 86, playhead: 0, playing: false,
        preview: '', previewBusy: false,
        selectedId: '', ripple: false,
        drag: null, rulerDrag: false,
        saving: false, exporting: false, exportJob: null, exportTimer: null,
        titleDraft: '',
      };
    },
    computed: {
      historyItems() {
        return this.histKind === 'audio' ? this.assets.filter((a) => a.kind === 'audio') : this.assets.filter((a) => a.kind === 'video' || a.kind === 'image');
      },
      tlDuration() {
        const tl = this.state && this.state.timeline;
        const clips = (tl && tl.clips) || [];
        const byClips = clips.reduce((mx, c) => Math.max(mx, (Number(c.start) || 0) + (Number(c.duration) || 0)), 0);
        // 时间线总长 = 最后一片段结尾的精确值，不再 +1 也不向上取整：
        // 视频真实时长常是小数（如 5.03s / 6.53s），取整会让「标尺/播放头」跟「片段结尾」对不齐，
        // 也就是用户看到的「视频显示 6 秒、却只画到约 5 秒、播放又跑到 7 秒」。
        return Math.max(5, Number(tl && tl.duration) || 0, byClips);
      },
      tlWidth() { return Math.ceil((this.tlDuration + 4) * this.pps); },
      rulerTicks() { const step = this.pps >= 50 ? 1 : (this.pps >= 25 ? 2 : 5); const out = []; for (let s = 0; s <= this.tlDuration + 4; s += step) out.push(s); return out; },
      tracksTopDown() { const t = (this.state && this.state.timeline && this.state.timeline.tracks) || []; return t.slice().sort((a, b) => b.index - a.index); },
      selected() { return ((this.state && this.state.timeline && this.state.timeline.clips) || []).find((c) => c.id === this.selectedId) || null; },
      hasAudioTrack() { const c = this.selected; if (!c || c.kind === 'audio') return c && c.kind === 'audio'; const m = this.mediaOf(c); return !!(m && m.hasAudio); },
    },
    async mounted() {
      window.addEventListener('mousemove', this.onMove);
      window.addEventListener('mouseup', this.onUp);
      window.addEventListener('keydown', this.onKey);
      await this.loadAssets();
      try {
        const d = await api('GET', '/edit/studio/state');
        this.projects = d.projects || [];
        if (d.open) { // 15 分钟内回来：会话还活着，直接进
          this.open = true; this.state = d.state; this.fetchPreview(); this.loadEffects();
          return;
        }
      } catch (e) { this.projects = []; }
      this.autoOpen(); // 默认直接进入：有存档续上次工程，没有就新建空工程
    },
    beforeUnmount() { this.stopPlay(); this.clearExportTimer(); },
    unmounted() {
      window.removeEventListener('mousemove', this.onMove);
      window.removeEventListener('mouseup', this.onUp);
      window.removeEventListener('keydown', this.onKey);
    },
    methods: {
      bytes, fmtTime, authed,
      fmtS(t) { t = Math.max(0, Number(t) || 0); const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1); },
      async loadAssets() { try { const d = await api('GET', '/edit/assets'); this.assets = d.items || []; } catch (e) {} },
      // ---- 本机素材导入（≤50MB 走 base64 JSON，与语音克隆同一通道）----
      pickImport() { const el = this.$refs.fileInput; if (el) el.click(); },
      // ---- 从历史导入（本系统生成的视频/图片/配音 → 引擎素材库）----
      openHistory(kind) { this.histKind = kind; this.historyPick = true; this.loadAssets(); },
      async importHistory(a) {
        this.histBusy = a.name;
        try { const d = await api('POST', '/edit/studio/import', { kind: a.kind, name: a.name }); this.state = d.state; }
        catch (e) { alert(e.message); }
        finally { this.histBusy = ''; }
      },
      async importFiles(ev) {
        const files = Array.from((ev.target && ev.target.files) || []);
        if (ev.target) ev.target.value = '';
        if (!files.length) return;
        this.importing = true;
        let okN = 0, fail = '';
        try {
          for (const f of files) {
            if (f.size > 50 * 1024 * 1024) { fail = f.name + ' 超过 50MB'; continue; }
            try {
              const b64 = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(new Error('读取失败')); r.readAsDataURL(f); });
              await api('POST', '/edit/assets/upload', { name: f.name, data_base64: b64 });
              okN++;
            } catch (e) { fail = e.message; }
          }
          if (okN) await this.loadAssets();
        } finally { this.importing = false; }
        alert(okN ? `成功导入 ${okN} 个素材，已出现在素材列表里${fail ? '；失败：' + fail : ''}` : '导入失败：' + (fail || '未知原因'));
      },
      inBin(a) { return ((this.state && this.state.media) || []).some((m) => basename(m.path) === a.name); },
      mediaOf(c) { return ((this.state && this.state.media) || []).find((m) => m.id === c.media) || null; },

      // ---- 打开 / 新建（一步直达：不再有开屏选择卡） ----
      async autoOpen() {
        this.opening = true; this.openError = '';
        try {
          const d = await api('POST', '/edit/studio/open', { resume: this.projects.length > 0, items: [] });
          this.open = true; this.state = d.state; this.projects = d.projects || [];
          this.selectedId = ''; this.fetchPreview(); this.loadEffects();
        } catch (e) { this.openError = e.message; }
        finally { this.opening = false; }
      },
      async newProject() {
        if (this.opening) return;
        if (!confirm('新建空工程？当前工程会先自动保存。')) return;
        this.opening = true;
        try {
          try { await api('POST', '/edit/studio/close', {}); } catch (e) {}
          const d = await api('POST', '/edit/studio/open', { resume: false, items: [] });
          this.open = true; this.state = d.state; this.projects = d.projects || [];
          this.selectedId = ''; this.playhead = 0; this.preview = '';
          if (this._pc) this._pc.clear();
          this.fetchPreview(); this.loadEffects();
        } catch (e) { alert(e.message); }
        finally { this.opening = false; }
      },
      async save() { this.saving = true; try { await api('POST', '/edit/studio/save', {}); } catch (e) { alert(e.message); } finally { this.saving = false; } },

      // ---- 命令通道 ----
      async cmd(op, args) {
        try {
          const d = await api('POST', '/edit/studio/command', Object.assign({ op }, args || {}));
          this.state = d.state; this.playhead = Math.min(this.playhead, this.tlDuration);
          this.fetchPreview();
          return true;
        } catch (e) { alert(e.message); return false; }
      },
      async patch(p) { if (!this.selected) return; await this.cmd('updateClip', { clipId: this.selected.id, patch: p }); },
      async transform(p) { if (!this.selected) return; await this.cmd('setClipTransform', Object.assign({ clipId: this.selected.id }, p)); },
      async frame(framing) { if (!this.selected) return; await this.cmd('frameClip', { clipId: this.selected.id, framing }); },
      async undo(redo) { try { const d = await api('POST', '/edit/studio/undo', { redo }); this.state = d.state; this.fetchPreview(); } catch (e) { alert(e.message); } },
      async trackFlag(tr, flag, value) { await this.cmd('setTrackFlag', { trackId: tr.id, flag, value }); },
      addTrack() { this.cmd('addTrack', {}); },

      // ---- 九页签素材库：目录/文本/贴纸/效果 ----
      effName(e) { return (e && EFF_ZH[e.id]) || (e && e.name) || ''; },
      catName(e) { return (e && CAT_ZH[e.category]) || (e && e.category) || ''; },
      effIdLabel(id) { return EFF_ZH[id] || String(id || '').replace(/^concat\./, ''); },
      effectsOf(tab) {
        if (!this.effects) return [];
        if (tab === 'transition') return this.effects.filter((e) => e.kind === 'transition');
        if (tab === 'effect') return this.effects.filter((e) => e.kind === 'effect');
        if (tab === 'filter') return this.effects.filter((e) => e.kind === 'filter' && e.id !== 'concat.adjust');
        if (tab === 'adjust') return this.effects.filter((e) => e.id === 'concat.adjust');
        if (tab === 'audio') return this.effects.filter((e) => e.kind === 'audio');
        return [];
      },
      async loadEffects() {
        if (this.effects) return;
        try { const d = await api('GET', '/edit/studio/effects'); this.effects = d.effects || []; }
        catch (e) { /* 引擎没装/目录拉不到 → 相关页签显示空 */ }
      },
      addTextPreset(p) {
        this.cmd('addTextClip', {
          start: this.playhead, above: true, duration: 3,
          style: { content: p.content, ...(p.style || {}) },
          ...(p.offsetY != null ? { offsetY: p.offsetY } : {}),
        });
      },
      addSticker(s) {
        const base = { width: this.stickerSize, fill: this.stickerColor, ...(STICKER_STYLE[s.id] || { kind: s.id }) };
        if (s.id === 'line' || s.id === 'arrow') { base.stroke = this.stickerColor; base.strokeWidth = 0.02; }
        this.cmd('addShapeClip', { start: this.playhead, above: true, duration: 2, name: s.label + '贴纸', style: base });
      },
      addEffectCard(e) {
        if (e.kind === 'transition') {
          this.cmd('addTransitionClip', { start: this.playhead, duration: 0.8, transitionId: e.id, name: this.effName(e) });
        } else {
          // 效果/滤镜/调节/音效：铺到播放头；选中着片段就取它的时长（整段生效）
          const dur = this.selected && this.selected.duration ? this.selected.duration : 3;
          this.cmd('addLayerClip', { start: this.playhead, duration: dur, effectId: e.id, name: this.effName(e), ...(e.kind === 'audio' ? { sound: true } : {}) });
        }
      },

      // ---- 复制选中片段（媒体/文字）：新建后回填属性 ----
      async duplicateSel() {
        const c = this.selected;
        if (!c) return;
        if (c.kind === 'text') {
          await this.cmd('addTextClip', { start: this.playhead, above: true, duration: c.duration, style: { content: c.text } });
          return;
        }
        if (!c.media) { alert('该类型暂不支持复制——请从左侧对应页签重新添加'); return; }
        const okAdd = await this.cmd('addClipAtFirstFree', { mediaId: c.media, start: this.playhead });
        if (!okAdd) return;
        let nid = this.state.createdId;
        if (!nid) { // 兜底：找落在播放头上的同素材新片段
          const cand = (this.state.timeline.clips || []).filter((x) => x.media === c.media && x.id !== c.id && Math.abs(x.start - this.playhead) < 0.05);
          nid = cand.length ? cand[cand.length - 1].id : '';
        }
        if (!nid) return;
        this.selectedId = nid;
        const patch = {};
        for (const k of ['volume', 'fadeIn', 'fadeOut', 'opacity', 'muted', 'flipH', 'flipV']) if (c[k] != null) patch[k] = c[k];
        if (Object.keys(patch).length) await this.cmd('updateClip', { clipId: nid, patch });
        const tf = {};
        for (const k of ['scale', 'offsetX', 'offsetY', 'rotation']) if (c[k] != null && !(k === 'scale' && c[k] === 1) && c[k] !== 0) tf[k] = c[k];
        if (Object.keys(tf).length) await this.cmd('setClipTransform', Object.assign({ clipId: nid }, tf));
        if (c.speed != null && c.speed !== 1) await this.cmd('setClipSpeed', { clipId: nid, speed: c.speed, ripple: false });
      },
      applyTitle() { if (this.selected) this.patch({ text: { content: this.titleDraft } }); },
      splitSel() {
        const c = this.selected; if (!c) return;
        if (this.playhead <= c.start + 0.02 || this.playhead >= c.start + c.duration - 0.02) { alert('播放头不在该片段内——先把播放头移到要切的位置'); return; }
        this.cmd('splitClips', { clipIds: [c.id], time: this.playhead });
      },
      removeSel() { const c = this.selected; if (!c) return; this.cmd('removeClips', { clipIds: [c.id], ripple: this.ripple }); this.selectedId = ''; },

      // ---- 素材入库并放到播放头 ----
      async addToTimeline(a) {
        this.binBusy = true;
        try {
          const d = await api('POST', '/edit/studio/import', { kind: a.kind, name: a.name });
          this.state = d.state;
          const m = (this.state.media || []).find((x) => basename(x.path) === a.name);
          if (m) await this.cmd('addClipAtFirstFree', { mediaId: m.id, start: this.playhead });
        } catch (e) { alert(e.message); }
        finally { this.binBusy = false; }
      },
      // 删除素材（素材库）：删记录 + 落盘文件，然后从列表移除
      async delAsset(a) {
        if (!confirm('删除素材「' + (a.prompt || a.name) + '」及其文件？')) return;
        try {
          await api('DELETE', '/edit/assets/' + a.src + '/' + encodeURIComponent(a.id));
          this.assets = this.assets.filter((x) => !(x.src === a.src && String(x.id) === String(a.id)));
        } catch (e) { alert(e.message); }
      },

      // ---- 时间线：拖动 / 修剪 / 播放头 ----
      clipsOn(trackId) { return (((this.state && this.state.timeline && this.state.timeline.clips) || []).filter((c) => c.track === trackId)).sort((a, b) => a.start - b.start); },
      clipLabel(c) {
        if (c.kind === 'text') return 'T ' + (c.text || '');
        const m = this.mediaOf(c);
        return (m ? m.name : (c.name || c.id)) + (c.muted ? ' 🔇' : '');
      },
      clipStyle(c) {
        const d = this.drag && this.drag.id === c.id ? this.drag : null;
        let start = c.start, dur = c.duration;
        if (d && d.mode === 'move') start = Math.max(0, d.start0 + d.dx / this.pps);
        if (d && d.mode === 'r') dur = Math.max(0.05, d.dur0 + d.dx / this.pps);
        if (d && d.mode === 'l') { const nd = Math.max(0.05, d.dur0 - d.dx / this.pps); start = d.start0 + (d.dur0 - nd); dur = nd; }
        return { left: start * this.pps + 'px', width: Math.max(8, dur * this.pps) + 'px' };
      },
      clipDown(e, c, mode) {
        this.stopPlay();
        this.selectedId = c.id;
        if (c.kind === 'text') this.titleDraft = c.text || '';
        this.drag = { id: c.id, mode, x0: e.clientX, y0: e.clientY, start0: c.start, dur0: c.duration, track0: c.track, dx: 0, clicked: true };
      },
      laneAt(y) {
        for (const el of document.querySelectorAll('.tl-lane')) {
          const r = el.getBoundingClientRect();
          if (y >= r.top && y <= r.bottom) return el.getAttribute('data-track');
        }
        return null;
      },
      onMove(e) {
        if (this.drag) { this.drag.dx = e.clientX - this.drag.x0; if (Math.abs(this.drag.dx) > 3) this.drag.clicked = false; this.drag.targetTrack = this.laneAt(e.clientY); }
        if (this.rulerDrag) this.seek(Math.max(0, (e.clientX - this.laneLeft()) / this.pps));
      },
      laneLeft() { const el = document.querySelector('.tl-lane'); return el ? el.getBoundingClientRect().left : 0; },
      onUp() {
        const d = this.drag; this.rulerDrag = false;
        if (!d) return;
        this.drag = null;
        if (d.clicked) { this.fetchPreview(); return; } // 单击=选中
        const dxS = d.dx / this.pps;
        if (d.mode === 'move') {
          const start = Math.max(0, Math.round((d.start0 + dxS) * 100) / 100);
          const trackId = d.targetTrack || d.track0;
          this.cmd('moveClips', { moves: [{ clipId: d.id, start, trackId }] });
        } else if (d.mode === 'l') {
          this.cmd('trimClip', { clipId: d.id, edge: 'start', delta: Math.round(dxS * 100) / 100, ripple: this.ripple });
        } else if (d.mode === 'r') {
          this.cmd('trimClip', { clipId: d.id, edge: 'end', delta: Math.round(dxS * 100) / 100, ripple: this.ripple });
        }
      },
      rulerDown(e) { this.stopPlay(); this.rulerDrag = true; this.seek(Math.max(0, (e.clientX - this.laneLeft()) / this.pps)); },
      // 点时间线空白处：红线（播放头）跟到点击处，预览同步该帧；按住可拖动
      laneDown(e) {
        if (e.target.closest('.tl-clip') || e.target.closest('.tl-trackhead') || e.target.closest('button')) return;
        this.stopPlay(); this.rulerDrag = true;
        this.seek(Math.max(0, (e.clientX - this.laneLeft()) / this.pps));
      },
      seek(t) { this.playhead = Math.max(0, Math.min(this.tlDuration, Math.round(t * 100) / 100)); this.fetchPreview(); },
      onKey(e) {
        if (!this.open) return;
        const tag = (e.target && e.target.tagName) || '';
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;
        if (e.key === 'Escape' && (this.zoomPreview || this.historyPick)) { this.zoomPreview = false; this.historyPick = false; return; }
        if (e.key === 'Delete' || e.key === 'Backspace') { if (this.selected) { e.preventDefault(); this.removeSel(); } }
        if (e.key === ' ') { e.preventDefault(); this.togglePlay(); }
      },

      // ---- 真实帧预览（服务端渲染，rev 变化即失效；内存缓存最近 80 帧） ----
      fetchPreview: (() => {
        let timer = null;
        return function () {
          clearTimeout(timer);
          timer = setTimeout(async () => {
            if (!this.open || this.previewBusy) return;
            const rev = this.state && this.state.rev;
            const key = rev + ':' + Math.round(this.playhead * 5) / 5;
            if (!this._pc) this._pc = new Map();
            if (this._pc.has(key)) { this.preview = this._pc.get(key); return; }
            this.previewBusy = true;
            try {
              const d = await api('GET', '/edit/studio/preview?t=' + this.playhead);
              if (d && d.png) {
                const src = 'data:image/png;base64,' + d.png;
                if (this._pc.size > 80) this._pc.clear();
                this._pc.set(key, src);
                this.preview = src;
              }
            } catch (e) { /* 预览失败不弹窗，下一次拖动再试 */ }
            finally { this.previewBusy = false; }
          }, 120);
        };
      })(),
      togglePlay() { this.playing ? this.stopPlay() : this.startPlay(); },
      async startPlay() {
        if (this.playing) return;
        if (this.playhead >= this.tlDuration - 0.05) this.playhead = 0;
        this.playing = true;
        let last = performance.now();
        while (this.playing) {
          await new Promise((r) => setTimeout(r, 40)); // 帧节拍上限 ~25fps，避免刷爆服务端渲染
          const now = performance.now();
          // 按真实流逝时间推进播放头 = 严格 1x 倍速（此前固定每 80ms +0.5s = 6.25x 过快，2026-11-09 报障）
          this.playhead = Math.min(this.tlDuration, this.playhead + (now - last) / 1000);
          last = now;
          await this.fetchPreviewNow();
          if (this.playhead >= this.tlDuration) { this.playing = false; break; }
        }
      },
      stopPlay() { this.playing = false; },
      async fetchPreviewNow() {
        this.playhead = this.playhead; // 触发缓存键
        const rev = this.state && this.state.rev;
        const key = rev + ':' + Math.round(this.playhead * 5) / 5;
        if (!this._pc) this._pc = new Map();
        if (this._pc.has(key)) { this.preview = this._pc.get(key); return; }
        try {
          const d = await api('GET', '/edit/studio/preview?t=' + this.playhead);
          if (d && d.png) {
            const src = 'data:image/png;base64,' + d.png;
            if (this._pc.size > 80) this._pc.clear();
            this._pc.set(key, src); this.preview = src;
          }
        } catch (e) {}
      },

      // ---- 导出 ----
      async doExport() {
        const title = prompt('成片标题（可选，进入素材库与合成记录）：', '');
        if (title === null) return;
        try {
          const d = await api('POST', '/edit/studio/export', { title });
          this.exporting = true; this.exportJob = { id: d.id, status: 'running', progress_pct: 0, progress: '' };
          this.clearExportTimer();
          this.exportTimer = setInterval(() => this.pollExport(), 2000);
        } catch (e) { alert(e.message); }
      },
      clearExportTimer() { if (this.exportTimer) { clearInterval(this.exportTimer); this.exportTimer = null; } },
      async pollExport() {
        try {
          const d = await api('GET', '/edit/jobs');
          const j = (d.jobs || []).find((x) => x.id === (this.exportJob && this.exportJob.id));
          if (!j) return;
          this.exportJob = j;
          if (['done', 'failed', 'cancelled'].includes(j.status)) {
            this.exporting = false; this.clearExportTimer();
            if (j.status === 'failed') alert('导出失败：' + j.error);
            this.$emit('done');
          }
        } catch (e) {}
      },
      tfVal(k) { const c = this.selected; return c ? c[k] : undefined; },
    },
  };

  // ---------- 设置 ----------
  const Settings = {
    template: `
    <div>
      <div class="page-head"><h2>设置</h2></div>
      <div class="tabs">
        <button class="tab" :class="{active: tab==='theme'}" @click="tab='theme'">主题</button>
        <template v-if="isAdmin">
          <button class="tab" :class="{active: tab==='ai'}" @click="tab='ai'">AI 设置</button>
          <button class="tab" :class="{active: tab==='users'}" @click="tab='users'">用户管理</button>
          <button class="tab" :class="{active: tab==='invites'}" @click="tab='invites'">邀请码</button>
          <button class="tab" :class="{active: tab==='cert'}" @click="tab='cert'">HTTPS 证书</button>
          <button class="tab" :class="{active: tab==='upgrade'}" @click="tab='upgrade'">系统升级</button>
          <button class="tab" :class="{active: tab==='comfy'}" @click="tab='comfy'; comfyCheck()">后端升级</button>
          <button class="tab" :class="{active: tab==='logs'}" @click="tab='logs'">登录日志 / IP 封禁</button>
        </template>
        <button class="tab" :class="{active: tab==='credits'}" @click="tab='credits'">致谢</button>
      </div>

      <div v-if="tab==='theme'" class="card">
        <h3>主题</h3>
        <div class="row">
          <button class="btn" :class="{primary: store.theme==='day'}" @click="setTheme('day')">白天</button>
          <button class="btn" :class="{primary: store.theme==='night'}" @click="setTheme('night')">夜晚</button>
        </div>
        <div class="field" style="margin-top:16px;max-width:340px"><label>修改密码</label><input type="password" v-model="oldP" placeholder="原密码" /></div>
        <div class="field" style="max-width:340px"><input type="password" v-model="newP" placeholder="新密码（至少 4 位）" /></div>
        <button class="btn" @click="chgPass">修改密码</button>
      </div>

      <div v-if="tab==='ai'" class="card">
        <h3>AI 设置（系统大模型接入）</h3>
        <div class="muted" style="margin-bottom:12px">供衍像内置 AI 功能调用（与工作台「API 接入」同款配置）。兼容 OpenAI Chat Completions 协议的服务商/网关（DeepSeek、Kimi、通义、one-api 等）。密钥仅保存在本服务器数据库，不会出现在日志里。</div>
        <div class="field" style="max-width:560px"><label>接入地址（Base URL）</label><input v-model="ai.url" placeholder="例如 https://api.deepseek.com/v1 或自建网关地址" /></div>
        <div class="field" style="max-width:560px">
          <label>API Key</label>
          <div style="display:flex;gap:8px">
            <input :type="aiShow ? 'text' : 'password'" v-model="ai.key" placeholder="sk-…（服务商控制台获取）" style="flex:1" />
            <button class="btn sm" style="flex:none" @click="aiShow=!aiShow">{{ aiShow ? '隐藏' : '显示' }}</button>
          </div>
        </div>
        <div class="field" style="max-width:560px"><label>模型名称</label><input v-model="ai.model" placeholder="例如 kimi-k2.6 / deepseek-chat / gpt-4o-mini，以服务商模型列表为准" /></div>
        <div class="row" style="flex:none">
          <button class="btn primary" :disabled="aiBusy" @click="saveAi">{{ aiBusy ? '处理中…' : '保存配置' }}</button>
          <button class="btn" :disabled="aiBusy" @click="testAi">测试连接</button>
        </div>
        <div v-if="aiTest" class="alert" :class="aiTest.ok ? 'ok' : 'err'" style="margin-top:12px;max-width:560px">
          <template v-if="aiTest.ok">✓ 连接成功 · 模型 {{ aiTest.model }} · 延迟 {{ aiTest.latency_ms }} ms · 回复：{{ aiTest.reply || '-' }}</template>
          <template v-else>✗ {{ aiTest.error }}</template>
        </div>
      </div>

      <div v-if="tab==='credits'" class="card">
        <h3>致谢</h3>
        <div class="muted" style="margin-bottom:14px">衍像的生成与剪辑能力站在以下开源项目与开放模型的肩膀上，谨致谢忱。</div>

        <div class="credit-item">
          <div class="credit-head"><span class="material-icons credit-ic">content_cut</span><b>Concat</b><span class="badge dim">AGPL-3.0</span></div>
          <div>开源跨平台视频剪辑器（macOS / Windows / Linux / Android）——【视频剪辑】功能的剪辑内核。无水印、免账号、完全本地运行，界面自带简体中文。致谢开发者 <b>jub0t</b> 与全体贡献者。</div>
          <div class="credit-links">
            <a href="https://github.com/jub0t/Concat" target="_blank" rel="noopener">github.com/jub0t/Concat</a>
            <a href="https://concat.standalones.org" target="_blank" rel="noopener">concat.standalones.org</a>
          </div>
        </div>

        <div class="credit-sub">生成模型</div>
        <div class="credit-grid">
          <div class="credit-item">
            <div class="credit-head"><span class="material-icons credit-ic">image</span><b>Z-Image</b></div>
            <div>文生图模型 · 阿里巴巴 通义实验室（Tongyi Lab）</div>
          </div>
          <div class="credit-item">
            <div class="credit-head"><span class="material-icons credit-ic">switch_video</span><b>Wan 2.2</b></div>
            <div>首尾帧图生视频模型（A14B，LightX2V 蒸馏加速）· 阿里巴巴 通义万相</div>
          </div>
          <div class="credit-item">
            <div class="credit-head"><span class="material-icons credit-ic">movie</span><b>MiniMax-H3</b></div>
            <div>音视频一体生成模型 · MiniMax</div>
          </div>
          <div class="credit-item">
            <div class="credit-head"><span class="material-icons credit-ic">record_voice_over</span><b>MOSS-TTS</b></div>
            <div>语音合成与音色克隆（本地离线 MOSS-TTS-Nano）· 复旦大学 OpenMOSS 团队</div>
          </div>
        </div>

        <div class="credit-sub">推理底座</div>
        <div class="credit-item">
          <div class="credit-head"><span class="material-icons credit-ic">hub</span><b>ComfyUI</b><span class="badge dim">GPL-3.0</span></div>
          <div>节点式生成推理引擎，上述模型的本地运行底座。致谢 comfyanonymous 与社区。</div>
          <div class="credit-links"><a href="https://github.com/comfyanonymous/ComfyUI" target="_blank" rel="noopener">github.com/comfyanonymous/ComfyUI</a></div>
        </div>

        <div class="muted" style="margin-top:14px">以上项目的权利归各自作者与机构所有；衍像（EvolveShot）仅作本地化集成。向开源社区致敬。</div>
      </div>

      <div v-if="tab==='users'" class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
          <h3 style="margin:0">用户管理</h3>
          <button class="btn primary" @click="newUser">新建用户</button>
        </div>
        <table><thead><tr><th>ID</th><th>用户名</th><th>昵称</th><th>角色</th><th>已用/额度</th><th>锁定</th><th>操作</th></tr></thead>
        <tbody><tr v-for="u in users" :key="u.id">
          <td>{{ u.id }}</td><td>{{ u.username }}</td><td>{{ u.display_name }}</td>
          <td>{{ u.role }}</td>
          <td>{{ u.used }} / {{ u.quota < 0 ? '不限' : u.quota }}</td>
          <td><span v-if="u.lock_permanent" class="badge err">永久</span><span v-else-if="u.locked_until" class="badge warn">临时</span><span v-else class="badge ok">正常</span></td>
          <td style="white-space:nowrap">
            <button class="btn sm" @click="editUser(u)">编辑</button>
            <button v-if="u.lock_permanent || u.locked_until" class="btn sm" @click="unlock(u)">解锁</button>
            <button v-if="u.id !== store.user.id" class="btn sm danger" @click="delUser(u)">删除</button>
          </td>
        </tr></tbody></table>
      </div>

      <div v-if="tab==='invites'" class="card">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;flex-wrap:wrap;gap:10px">
          <h3 style="margin:0">邀请码</h3>
          <div style="display:flex;align-items:center;gap:8px">
            <input v-model="invNote" placeholder="备注（给谁用 / 用途）" style="width:240px;padding:8px 10px;border:1px solid var(--border);border-radius:8px;background:var(--bg-input);color:var(--text)" />
            <button class="btn primary" @click="genInvite">生成邀请码</button>
          </div>
        </div>
        <div class="muted" style="margin-bottom:10px">注册须持未使用的邀请码；一码一次性，注册成功即核销并记录使用者。点击邀请码可复制。</div>
        <table><thead><tr><th>邀请码</th><th>备注</th><th>生成人</th><th>生成时间</th><th>状态</th><th></th></tr></thead>
        <tbody><tr v-if="!invites.length"><td colspan="6" class="muted">还没有邀请码，点右上角生成</td></tr>
        <tr v-for="i in invites" :key="i.id">
          <td class="mono" style="cursor:pointer;letter-spacing:1px" title="点击复制" @click="copyInvite(i.code)">{{ i.code }}</td>
          <td>{{ i.note || '-' }}</td>
          <td>{{ i.created_by }}</td>
          <td class="muted">{{ fmtTime(i.created_at) }}</td>
          <td><span v-if="i.used_by" class="badge dim">已用 · {{ i.used_username }} · {{ fmtTime(i.used_at) }}</span><span v-else class="badge ok">未使用</span></td>
          <td><button v-if="!i.used_by" class="btn sm danger" @click="delInvite(i)">删除</button></td>
        </tr></tbody></table>
      </div>

      <div v-if="tab==='cert'" class="card">
        <h3>HTTPS 证书（自签名）</h3>
        <div v-if="cert.status" class="muted mono" style="white-space:pre-wrap">{{ JSON.stringify(cert.status, null, 2) }}</div>
        <div class="row" style="margin-top:12px">
          <div class="field" style="flex:2"><label>通用名称（CN / 域名）</label><input v-model="cert.cn" placeholder="例如 video.local 或 192.168.1.10" /></div>
          <div class="field"><label>有效期（天）</label><input type="number" v-model.number="cert.days" /></div>
        </div>
        <div class="field"><label>附加 SAN（逗号分隔，可选）</label><input v-model="cert.san" placeholder="域名或 IP" /></div>
        <div class="row" style="flex:none">
          <button class="btn primary" @click="genCert">生成证书</button>
          <button class="btn" @click="getStatus">刷新状态</button>
          <button class="btn" @click="dl('cert')">下载证书</button>
          <button class="btn" @click="dl('key')">下载私钥</button>
          <button class="btn danger" @click="restart('证书已更新')">重启生效</button>
        </div>
      </div>

      <div v-if="tab==='upgrade'" class="card">
        <h3>系统升级</h3>
        <div class="muted" style="margin-bottom:10px">当前版本：<b>{{ up.version }}</b></div>
        <div class="row" style="flex:none;margin-bottom:14px">
          <div class="field"><label>打包版本号</label><input v-model="up.pkgVer" placeholder="例如 1.0.1" /></div>
          <button class="btn primary" @click="pkg">打包升级包</button>
          <button class="btn" @click="listUp">刷新列表</button>
        </div>
        <table><thead><tr><th>升级包</th><th>大小</th><th>时间</th><th>操作</th></tr></thead>
        <tbody><tr v-for="f in up.list" :key="f.file">
          <td class="mono">{{ f.file }}</td><td>{{ bytes(f.size) }}</td><td class="muted">{{ fmtTime(f.mtime) }}</td>
          <td><button class="btn sm" @click="apply(f)">应用</button> <a class="btn sm" :href="'/api/upgrade/download/'+f.file+'?token='+token()">下载</a></td>
        </tr></tbody></table>
      </div>

      <div v-if="tab==='comfy'" class="card">
        <h3>ComfyUI 后端升级检测</h3>
        <div class="muted" style="margin-bottom:10px">检测统一后端（{{ comfy.chk ? comfy.chk.base : '8189' }}）的 ComfyUI 版本：是否满足「文生图H3」（需 ≥ {{ comfy.chk ? comfy.chk.required : '0.37' }}）、线上是否有新版。在线探测走 gh-proxy，离线不影响本地结论。</div>
        <div class="row" style="flex:none;margin-bottom:12px">
          <button class="btn primary" :disabled="comfy.busy" @click="comfyCheck">{{ comfy.busy ? '检测中…' : '立即检测' }}</button>
          <span v-if="comfy.chk" class="muted">检测于 {{ fmtTime(new Date(comfy.chk.checkedAt)) }}</span>
        </div>
        <template v-if="comfy.chk">
          <div class="alert" :class="!comfy.chk.reachable ? 'err' : (comfy.chk.meetsRequired === false ? 'err' : 'ok')" style="margin-bottom:12px">{{ comfy.chk.advice }}</div>
          <table><tbody>
            <tr><td class="muted" style="width:140px">后端状态</td><td><span class="badge" :class="comfy.chk.reachable ? 'ok' : 'err'">{{ comfy.chk.reachable ? '在线' : '不可达' }}</span></td></tr>
            <tr><td class="muted">当前版本</td><td><b>{{ comfy.chk.current || '未知' }}</b> <span v-if="comfy.chk.meetsRequired !== null" class="badge" :class="comfy.chk.meetsRequired ? 'ok' : 'err'">{{ comfy.chk.meetsRequired ? '满足文生图H3' : '低于所需' }}</span></td></tr>
            <tr><td class="muted">文生图H3 所需</td><td>≥ {{ comfy.chk.required }}（Image Studio 节点包要求）</td></tr>
            <tr><td class="muted">线上最新</td><td>{{ comfy.chk.latest || ('未知 ' + (comfy.chk.onlineNote || '')) }} <span v-if="comfy.chk.hasUpdate" class="badge warn">有新版</span></td></tr>
            <tr v-if="comfy.chk.vram"><td class="muted">算力卡</td><td>{{ comfy.chk.vram }}</td></tr>
          </tbody></table>
          <div class="muted" style="margin-top:12px;font-size:12px">升级流程（队列空闲时执行）：① 备份现有 ComfyUI 目录 → ② 换入新版核心（模型/节点包不动）→ ③ start-model.bat 拉起 → ④ 回到本页复检。G 盘环境已内置路径自愈，挪动/升级后首次启动会自动修正引用。</div>
        </template>
      </div>

      <div v-if="tab==='logs'" class="card">
        <h3>登录日志</h3>
        <div class="muted" style="margin-bottom:8px">
          规则：同一 IP 15 分钟内密码错误 <b>5 次</b> → 锁定该账号（需管理员解锁）；累计 <b>10 次</b>（含锁定后的继续尝试、不存在的用户名）→ 封禁该 IP（回环地址除外，窗口过 15 分钟自动清零）。<br>
          失败的登录尝试会记录当时输入的密码，便于核查暴力破解；每条记录可直接封禁来源 IP。
        </div>
        <table><thead><tr><th>时间</th><th>用户名</th><th>IP</th><th>尝试密码</th><th>结果</th><th>原因</th><th></th></tr></thead>
        <tbody><tr v-for="l in pagedLogs" :key="l.id">
          <td class="muted">{{ fmtTime(l.created_at) }}</td><td>{{ l.username }}</td><td class="mono">{{ l.ip }}</td>
          <td><span v-if="l.password" class="mono">{{ l.password }}</span><span v-else class="muted">-</span></td>
          <td><span class="badge" :class="l.success?'ok':'err'">{{ l.success?'成功':'失败' }}</span></td><td class="muted">{{ l.reason }}</td>
          <td><button class="btn sm danger" :disabled="isBanned(l.ip)" @click="banFromLog(l)">{{ isBanned(l.ip) ? '已封禁' : '封禁' }}</button></td>
        </tr></tbody></table>
        <div class="row" style="flex:none;align-items:center;justify-content:flex-end;margin-top:10px;gap:10px">
          <span class="muted">共 {{ logs.length }} 条</span>
          <label class="muted">每页
            <select v-model.number="logsSize" @change="logsPage=1" style="margin:0 6px">
              <option :value="10">10</option><option :value="20">20</option><option :value="50">50</option><option :value="100">100</option>
            </select>行</label>
          <button class="btn sm" :disabled="logsPage<=1" @click="logsPage--">‹ 上一页</button>
          <span class="muted">{{ logsPage }} / {{ logsPages }}</span>
          <button class="btn sm" :disabled="logsPage>=logsPages" @click="logsPage++">下一页 ›</button>
        </div>
      </div>

      <div v-if="tab==='logs'" class="card">
        <h3>IP 封禁</h3>
        <div class="row" style="flex:none;margin-bottom:12px;align-items:center">
          <div class="field" style="flex:2;margin:0"><input v-model="banIp" placeholder="IP 地址" /></div>
          <div class="field" style="flex:2;margin:0"><input v-model="banNote" placeholder="备注" /></div>
          <button class="btn danger" @click="addBan">封禁</button>
        </div>
        <table><thead><tr><th>IP</th><th>备注</th><th>操作人</th><th>时间</th><th></th></tr></thead>
        <tbody><tr v-for="b in bans" :key="b.ip"><td class="mono">{{ b.ip }}</td><td>{{ b.note }}</td><td>{{ b.created_by }}</td><td class="muted">{{ fmtTime(b.created_at) }}</td><td><button class="btn sm" @click="unban(b)">解封</button></td></tr></tbody></table>
      </div>

      <div v-if="udialog" class="overlay">
        <div class="dialog">
          <h3>{{ udialog.id ? '编辑用户' : '新建用户' }}</h3>
          <div class="field"><label>用户名</label><input v-model="udialog.username" :disabled="!!udialog.id" /></div>
          <div class="field"><label>{{ udialog.id ? '重置密码（留空不改）' : '密码' }}</label><input type="password" v-model="udialog.password" /></div>
          <div class="field"><label>昵称</label><input v-model="udialog.display_name" /></div>
          <div class="row">
            <div class="field"><label>角色</label><select v-model="udialog.role"><option value="user">普通用户</option><option value="admin">管理员</option></select></div>
            <div class="field"><label>生成额度（-1 不限）</label><input type="number" v-model.number="udialog.quota" /></div>
          </div>
          <div class="field"><label>授权页（按页面勾选可访问的权限）</label>
            <div class="page-perms">
              <label v-for="p in allPages" :key="p.key" class="chk"><input type="checkbox" :value="p.key" v-model="udialog.allowed_pages" /> {{ p.label }}</label>
            </div>
          </div>
          <div class="actions">
            <button class="btn" @click="udialog=null">取消</button>
            <button class="btn primary" @click="saveUser">保存</button>
          </div>
        </div>
      </div>
    </div>`,
    data() {
      return {
        store, tab: 'theme', isAdmin: store.user && store.user.role === 'admin',
        oldP: '', newP: '',
        users: [],
        allPages: [
          { key: 'generate', label: '首尾视频' }, { key: 'zimage', label: '文生图' }, { key: 'ad', label: '分层图' },
          { key: 'h3', label: '生视频H3' }, { key: 'ha', label: '远程开机' },
          { key: 'tasks', label: '任务中心' }, { key: 'history', label: '我的历史' },
          { key: 'voice', label: '语音配音' }, { key: 'edit', label: '视频剪辑' },
          { key: 'user-history', label: '用户历史' },
          { key: 'models', label: '模型配置' }, { key: 'settings', label: '设置' },
        ],
        cert: { cn: '', days: 820, san: '', status: null },
        up: { version: '', pkgVer: '', list: [] },
        comfy: { chk: null, busy: false },
        ai: { url: '', key: '', model: '' }, aiShow: false, aiTest: null, aiBusy: false,
        logs: [], bans: [], banIp: '', banNote: '',
        logsPage: 1, logsSize: 10,
        invites: [], invNote: '',
        udialog: null,
      };
    },
    computed: {
      logsPages() { return Math.max(1, Math.ceil((this.logs || []).length / this.logsSize)); },
      pagedLogs() { const s = (this.logsPage - 1) * this.logsSize; return (this.logs || []).slice(s, s + this.logsSize); },
    },
    async mounted() {
      if (this.isAdmin) { this.loadUsers(); this.loadInvites(); this.loadLogs(); this.loadBans(); this.loadCert(); this.loadUp(); this.loadAi(); }
    },
    methods: {
      token, fmtTime, bytes,
      setTheme(t) { store.setTheme(t); },
      async loadAi() { try { this.ai = await api('GET', '/ai/config'); this.aiTest = null; } catch (e) {} },
      async saveAi() {
        this.aiBusy = true;
        try { await api('PUT', '/ai/config', this.ai); alert('AI 配置已保存'); }
        catch (e) { alert(e.message); }
        finally { this.aiBusy = false; }
      },
      async testAi() {
        this.aiBusy = true; this.aiTest = null;
        try { this.aiTest = await api('POST', '/ai/test', this.ai); }
        catch (e) { this.aiTest = { ok: false, error: e.message }; }
        finally { this.aiBusy = false; }
      },
      async chgPass() { try { await api('POST', '/auth/password', { old: this.oldP, next: this.newP }); this.oldP = this.newP = ''; alert('密码已修改'); } catch (e) { alert(e.message); } },
      async loadUsers() { const d = await api('GET', '/users'); this.users = d.users; },
      async loadInvites() { const d = await api('GET', '/invites'); this.invites = d.invites; },
      async genInvite() {
        try {
          const d = await api('POST', '/invites', { note: this.invNote });
          this.invNote = ''; this.loadInvites();
          alert('已生成邀请码：' + d.code + (d.note ? '（' + d.note + '）' : ''));
        } catch (e) { alert(e.message); }
      },
      async delInvite(i) {
        if (!confirm('删除邀请码 ' + i.code + ' ？')) return;
        try { await api('DELETE', '/invites/' + i.id); this.loadInvites(); } catch (e) { alert(e.message); }
      },
      copyInvite(c) { try { navigator.clipboard.writeText(c); alert('已复制：' + c); } catch (e) {} },
      newUser() { this.udialog = { id: 0, username: '', password: '', display_name: '', role: 'user', quota: 100, allowed_pages: ['generate', 'zimage', 'h3', 'history', 'voice', 'edit'] }; },
      editUser(u) { this.udialog = { id: u.id, username: u.username, password: '', display_name: u.display_name, role: u.role, quota: u.quota, allowed_pages: (u.allowed_pages || []).slice() }; },
      async saveUser() {
        try {
          if (this.udialog.id) {
            const b = { display_name: this.udialog.display_name, role: this.udialog.role, quota: this.udialog.quota, allowed_pages: this.udialog.allowed_pages };
            if (this.udialog.password) b.password = this.udialog.password;
            await api('PUT', '/users/' + this.udialog.id, b);
          } else {
            await api('POST', '/users', this.udialog);
          }
          this.udialog = null; this.loadUsers();
        } catch (e) { alert(e.message); }
      },
      async unlock(u) { await api('POST', '/users/' + u.id + '/unlock'); this.loadUsers(); },
      async delUser(u) { if (!confirm('删除用户「' + u.username + '」？')) return; await api('DELETE', '/users/' + u.id); this.loadUsers(); },
      async loadCert() { const d = await api('GET', '/ssl/status'); this.cert.status = d; },
      getStatus() { this.loadCert(); },
      async genCert() { try { const d = await api('POST', '/ssl/generate', { cn: this.cert.cn, days: this.cert.days, san: this.cert.san }); this.cert.status = d.status; } catch (e) { alert(e.message); } },
      dl(k) { window.open(authed('/api/ssl/file/' + k)); },
      async restart(msg) { if (!confirm((msg || '重启服务') + '，确认？')) return; await api('POST', '/upgrade/restart', {}); alert('服务重启中…'); },
      async loadUp() { const d = await api('GET', '/upgrade/status'); this.up.version = d.version; await this.listUp(); },
      async listUp() { const d = await api('GET', '/upgrade/list'); this.up.list = d.list; },
      async pkg() { try { const d = await api('POST', '/upgrade/package', { version: this.up.pkgVer }); this.listUp(); alert('已打包：' + d.file); } catch (e) { alert(e.message); } },
      async comfyCheck() { // v1.0.44 ComfyUI 后端升级检测（GET /system/comfy-check，仅管理员）
        this.comfy.busy = true;
        try { const d = await api('GET', '/system/comfy-check'); this.comfy.chk = d; } catch (e) { alert('检测失败：' + e.message); }
        this.comfy.busy = false;
      },
      async apply(f) { if (!confirm('应用升级包 ' + f.file + ' 并覆盖当前代码？')) return; try { await api('POST', '/upgrade/apply', { file: f.file }); await this.restart('升级完成'); } catch (e) { alert(e.message); } },
      async loadLogs() { const d = await api('GET', '/auth/login-logs'); this.logs = d.logs; },
      async loadBans() { const d = await api('GET', '/ip-bans'); this.bans = d.bans; },
      isBanned(ip) { return (this.bans || []).some((b) => b.ip === ip); },
      async banFromLog(l) {
        if (!l.ip) return;
        if (!confirm('封禁 IP ' + l.ip + ' ？')) return;
        try { await api('POST', '/ip-bans', { ip: l.ip, note: '由登录日志封禁：' + (l.username || '') + ' ' + (l.reason || '') }); this.loadBans(); } catch (e) { alert(e.message); }
      },
      async addBan() { try { await api('POST', '/ip-bans', { ip: this.banIp, note: this.banNote }); this.banIp = this.banNote = ''; this.loadBans(); } catch (e) { alert(e.message); } },
      async unban(b) { await api('DELETE', '/ip-bans/' + b.ip); this.loadBans(); },
    },
  };

  // ---------- GPU 算力浮窗（右下角：CPU / CUDA / 专用显存 / 共享显存 实时曲线；可缩进、可放大；远端算力切换） ----------
  const MAX_PTS = 90; // 1 秒/点 ≈ 90 秒窗口
  const GpuWidget = {
    template: `
    <div class="gpu-float">
      <button v-if="!expanded" class="gpu-pill" @click="open" :title="activeLabel + ' · ' + deviceTitle">
        <span class="gpu-dot" :class="{busy: cudaNow > 5}"></span> {{ cudaNow == null ? 'GPU —' : 'GPU ' + cudaNow + '%' }}<span v-if="cpuNow != null" style="margin-left:2px">· CPU {{ cpuNow }}%</span><span class="gpu-pill-src">{{ activeLabel }}</span>
      </button>
      <div v-else class="gpu-card" :class="{ big }">
        <div class="gpu-head">
          <span class="gpu-title" style="flex:none">{{ big ? '算力监控' : '算力' }}</span>
          <select v-model="source" class="gpu-src" :title="activeLabel + ' · 自动=跟随实际耗用的算力端'" :style="big ? '' : 'width:70px;max-width:70px;min-width:0;flex:none'">
            <option value="auto">自动 · 跟随耗用</option>
            <option v-for="s in sources" :key="s.key" :value="s.key">{{ s.label }}</option>
          </select>
          <button v-if="isAdmin" class="btn sm danger" style="flex:none;white-space:nowrap" :disabled="freeing" :title="'卸载 ' + activeLabel + ' 的模型并释放显存/共享显存；有运行中任务会先提醒'" @click="freeVram">{{ freeing ? (big ? '释放中…' : '…') : (big ? '释放显存' : '释放') }}</button>
          <span style="flex:1"></span>
          <button class="btn sm" style="flex:none" :title="big ? '还原' : '放大'" @click="big = !big">{{ big ? '⤡' : '⤢' }}</button>
          <button class="btn sm" style="flex:none" title="缩进" @click="expanded = false">—</button>
        </div>
        <div class="muted gpu-dev" :title="deviceTitle">{{ err ? '⚠ ' + err : activeLabel + ' · ' + deviceTitle }}</div>

        <div class="gpu-block">
          <div class="gpu-meta"><span>CPU 处理器</span><b :style="{ color: 'var(--chart-cpu, var(--primary))' }">{{ fmt(cpuNow, '%') }}</b></div>
          <canvas ref="cvCpu"></canvas>
          <div class="gpu-sub muted">整机处理器占用</div>
        </div>
        <div class="gpu-block">
          <div class="gpu-meta"><span>CUDA 计算</span><b :style="{ color: 'var(--chart-cuda, var(--success))' }">{{ fmt(cudaNow, '%') }}</b></div>
          <canvas ref="cvCuda"></canvas>
          <div class="gpu-sub muted">SM 利用率</div>
        </div>
        <div class="gpu-block">
          <div class="gpu-meta"><span>专用 GPU 内存</span><b :style="{ color: 'var(--chart-ded, #1d4ed8)' }">{{ fmt(dedNow, '%') }}</b></div>
          <canvas ref="cvDed"></canvas>
          <div class="gpu-sub muted">{{ latest && latest.dedicated ? latest.dedicated.used_mb + ' / ' + latest.dedicated.total_mb + ' MB' : '' }}</div>
        </div>
        <div class="gpu-block">
          <div class="gpu-meta"><span>共享 GPU 内存</span><b :style="{ color: 'var(--chart-shr, var(--warn))' }">{{ fmt(shrNow, '%') }}</b></div>
          <canvas ref="cvShr"></canvas>
          <div class="gpu-sub muted">{{ latest && latest.shared && latest.shared.used_mb != null ? latest.shared.used_mb + ' / ' + latest.shared.total_mb + ' MB' : (partial ? '远端仅显存数据' : '') }}</div>
        </div>
      </div>
    </div>`,
    data() {
      return { expanded: true, big: false, source: 'auto', sources: [],
        hist: {}, latests: {}, activeKey: 'local', err: '', timer: 0, seq: 0, freeing: false };
    },
    computed: {
      activeLabel() { const s = this.sources.find((x) => x.key === this.activeKey); return s ? s.label : '本机算力'; },
      isAdmin() { return !!(store.user && store.user.role === 'admin'); },
      activeLatest() { return this.latests[this.activeKey] || null; },
      activeHist() { return this.hist[this.activeKey] || { cpu: [], cuda: [], ded: [], shr: [] }; },
      cpuNow() { const h = this.activeHist.cpu; const v = h.length ? h[h.length - 1] : null; return (v == null || (this.activeLatest && this.activeLatest.partial)) ? null : v; },
      cudaNow() { const h = this.activeHist.cuda; const v = h.length ? h[h.length - 1] : null; return (v == null || (this.activeLatest && this.activeLatest.partial)) ? null : v; },
      dedNow() { const h = this.activeHist.ded; return h.length ? h[h.length - 1] : null; },
      shrNow() { const h = this.activeHist.shr; return h.length ? h[h.length - 1] : null; },
      partial() { return !!(this.activeLatest && this.activeLatest.partial); },
      latest() { return this.activeLatest; },
      deviceTitle() { return (this.activeLatest && this.activeLatest.device) || 'GPU'; },
    },
    mounted() { this.schedule(200); },
    unmounted() { clearTimeout(this.timer); },
    methods: {
      open() { this.expanded = true; this.schedule(0); },
      // 释放当前显示端（本机/远端）的显存：先让后端查任务，有任务先提醒（确认=停止并释放，取消=不动）；
      // 专用显存与共享显存（内存缓存）由后端一次一体释放。
      async freeVram() {
        if (this.freeing) return;
        const src = this.sources.find((s) => s.key === this.activeKey);
        const url = src && src.url ? src.url : '';
        this.freeing = true;
        try {
          let r = await api('POST', '/system/gpu/free', { url, stop: false });
          if (r && r.busy) {
            const lines = (r.jobs || []).map((j) => '· ' + j.kind + ' #' + j.id + '（' + (j.status === 'running' ? '运行中' : '排队中') + '）' + (j.prompt ? '：' + j.prompt : '')).join('\n');
            const q = '（ComfyUI 队列：运行 ' + r.running + ' 个、排队 ' + r.pending + ' 个）';
            const ok = confirm(this.activeLabel + ' 有任务在运行或排队：\n' + (lines || '· 本系统无记录的任务\n') + q +
              '\n\n「确定」= 停止这些任务并释放显存（专用显存 + 共享显存一体释放）\n「取消」= 不释放');
            if (!ok) return;
            r = await api('POST', '/system/gpu/free', { url, stop: true });
          }
          alert('已释放 ' + this.activeLabel + ' 的显存与共享显存' + (r && r.stopped ? '（停止任务 ' + r.stopped + ' 个）' : ''));
          this.schedule(200); // 下一拍立即刷新曲线
        } catch (e) { alert(e.message || String(e)); }
        finally { this.freeing = false; }
      },
      fmt(v, suffix) { return v == null ? '—' : Math.round(v) + suffix; },
      schedule(delay) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.tick(), delay);
      },
      push(key, d) {
        if (!d || !d.available) return;
        if (!this.hist[key]) this.hist[key] = { cpu: [], cuda: [], ded: [], shr: [] };
        const h = this.hist[key];
        h.cpu.push(d.cpu_pct != null ? d.cpu_pct : (d.partial ? null : 0));
        h.cuda.push(d.cuda_pct);
        h.ded.push(d.dedicated ? d.dedicated.pct : null);
        h.shr.push(d.shared && d.shared.pct != null ? d.shared.pct : (d.partial ? null : 0));
        for (const m of ['cpu', 'cuda', 'ded', 'shr']) if (h[m].length > MAX_PTS) h[m].shift();
        this.latests[key] = d;
      },
      score(key) { const d = this.latests[key]; if (!d || !d.available) return -1; return d.cuda_pct != null ? d.cuda_pct : (d.dedicated ? d.dedicated.pct : -1); },
      async tick() {
        const mySeq = ++this.seq;
        try {
          const d = await api('GET', '/system/gpu-all');
          if (mySeq !== this.seq) return;
          if (!d || !d.sources) { this.err = (d && d.error) || '采样不可用'; }
          else {
            this.err = '';
            this.sources = d.sources;
            this.push('local', d.local);
            for (const s of d.sources) if (s.url && d.remotes[s.url]) this.push(s.key, d.remotes[s.url]);
            // 自动：显示实际在耗用算力的一端（CUDA 高者优先，回退显存占用）；否则显示手选端
            let key = this.source;
            if (key === 'auto') {
              key = 'local';
              for (const s of d.sources) if (this.score(s.key) > this.score(key)) key = s.key;
            }
            this.activeKey = key;
            this.$nextTick(() => this.drawAll());
          }
        } catch (e) { this.err = e.message; }
        if (this.expanded) this.schedule(1000); else this.schedule(3000);
      },
      drawAll() { const h = this.activeHist; this.draw('cvCpu', h.cpu, '--chart-cpu', '#7c3aed'); this.draw('cvCuda', h.cuda, '--chart-cuda', '#15803d'); this.draw('cvDed', h.ded, '--chart-ded', '#1d4ed8'); this.draw('cvShr', h.shr, '--chart-shr', '#b45309'); },
      draw(ref, data, colorVar, fallback) {
        const c = this.$refs[ref];
        if (!c) return;
        const dpr = window.devicePixelRatio || 1;
        const w = c.clientWidth, h = c.clientHeight;
        if (!w || !h) return;
        if (c.width !== w * dpr || c.height !== h * dpr) { c.width = w * dpr; c.height = h * dpr; }
        const ctx = c.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, w, h);
        const css = getComputedStyle(document.documentElement);
        const color = (css.getPropertyValue(colorVar) || '').trim() || fallback;
        ctx.strokeStyle = css.getPropertyValue('--border') || '#ccc';
        ctx.lineWidth = 1;
        for (const f of [0.25, 0.5, 0.75]) {
          ctx.beginPath(); ctx.moveTo(0, h * f); ctx.lineTo(w, h * f); ctx.stroke();
        }
        const pts = data.slice(-MAX_PTS);
        if (!pts.length || pts.every((v) => v == null)) return;
        // 滚动窗口：每点固定像素宽（MAX_PTS 点正好铺满整幅），最新点贴右缘，旧点逐点左移滑出
        const slot = w / MAX_PTS;
        const xy = (i, v) => [w - (pts.length - 1 - i) * slot, h - (Math.max(0, Math.min(100, v)) / 100) * (h - 4) - 2];
        const trace = () => {
          ctx.beginPath();
          let started = false;
          pts.forEach((v, i) => {
            if (v == null) { started = false; return; }
            const [x, y] = xy(i, v);
            if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
          });
          return started;
        };
        // 曲线下半透明填充渐变（底部浓、顶部淡）
        if (trace()) {
          const firstX = w - (pts.length - 1) * slot;
          ctx.lineTo(w, h); ctx.lineTo(Math.max(0, firstX), h); ctx.closePath();
          const grad = ctx.createLinearGradient(0, 0, 0, h);
          grad.addColorStop(0, color + '0d');
          grad.addColorStop(1, color + '59');
          ctx.fillStyle = grad;
          ctx.fill();
          trace();
        }
        ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
      },
    },
  };

  // ---------- 媒体查看器（v1.0.15：文生图最近图 / 首尾视频·H3 最近视频，点开大图后 ←→ 前后翻页） ----------
  // 全局单例 store：任何页面 openViewer(items, idx) 即可打开；items = [{kind:'image'|'video', url, title, sub}]
  const viewerStore = reactive({ show: false, items: [], idx: 0, scale: 1 });
  function openViewer(items, idx) {
    const list = (items || []).filter((x) => x && x.url);
    if (!list.length) return;
    viewerStore.items = list;
    viewerStore.idx = Math.max(0, Math.min(list.length - 1, idx || 0));
    viewerStore.scale = 1;
    viewerStore.show = true;
  }
  const MediaViewer = {
    template: `
    <div v-if="v.show" class="zoom-overlay mv-overlay" @wheel.prevent="onWheel" @click.self="close">
      <div class="mv-bar">
        <span class="mv-count">{{ v.idx + 1 }} / {{ v.items.length }}</span>
        <span class="mv-title" :title="cur.title">{{ cur.title || '' }}</span>
        <span class="mv-sub" v-if="cur.sub">{{ cur.sub }}</span>
        <span style="flex:1"></span>
        <a class="btn sm mv-dl" :href="cur.url" download>下载</a>
        <button class="mv-x" title="关闭（Esc）" @click="close"><span class="material-icons">close</span></button>
      </div>
      <button v-if="v.items.length > 1" class="mv-btn left" title="上一个（←）" @click="step(-1)"><span class="material-icons">chevron_left</span></button>
      <div class="mv-stage">
        <img v-if="cur.kind === 'image'" :src="cur.url" :style="imgStyle" @dblclick="close" />
        <video v-else :key="cur.url" :src="cur.url" controls autoplay muted playsinline @dblclick="close"></video>
      </div>
      <button v-if="v.items.length > 1" class="mv-btn right" title="下一个（→）" @click="step(1)"><span class="material-icons">chevron_right</span></button>
      <div class="zoom-tip">{{ tipText }}</div>
    </div>`,
    data() { return { v: viewerStore }; },
    computed: {
      cur() { return this.v.items[this.v.idx] || { kind: 'image', url: '' }; },
      imgStyle() { return { transform: 'translate(-50%, -50%) scale(' + this.v.scale + ')' }; },
      tipText() {
        const base = this.v.items.length > 1 ? '← → 前后翻页 · ' : '';
        return base + (this.cur.kind === 'image' ? Math.round(this.v.scale * 100) + '% · 滚轮缩放 · ' : '') + '双击或点空白处关闭';
      },
    },
    methods: {
      step(d) {
        const n = this.v.items.length;
        if (n < 2) return;
        this.v.idx = (this.v.idx + d + n) % n; // 首尾循环翻页
        this.v.scale = 1;
      },
      close() { this.v.show = false; },
      onWheel(e) { if (this.cur.kind === 'image') this.v.scale = Math.min(8, Math.max(0.15, this.v.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15))); },
      onKey(e) {
        if (!this.v.show) return;
        if (e.key === 'Escape') this.close();
        else if (e.key === 'ArrowLeft') this.step(-1);
        else if (e.key === 'ArrowRight') this.step(1);
      },
    },
    mounted() { this._kd = (e) => this.onKey(e); window.addEventListener('keydown', this._kd); },
    unmounted() { window.removeEventListener('keydown', this._kd); },
  };

  // ---------- HomeAssistant（v1.0.11 自工作台移植；语音/别名/设备来源分流未随迁） ----------
  const HA_ICONS = {
    light: 'lightbulb', switch: 'power_settings_new', fan: 'air', climate: 'device_thermostat',
    cover: 'curtains', humidifier: 'water_drop', water_heater: 'hot_tub', media_player: 'speaker',
    input_boolean: 'toggle_on', lock: 'lock', scene: 'auto_awesome', script: 'code',
    automation: 'schedule', vacuum: 'cleaning_services', siren: 'notifications_active',
    button: 'smart_button', camera: 'photo_camera', sensor: 'sensors', binary_sensor: 'sensors',
    weather: 'partly_cloudy_day', person: 'person', device_tracker: 'location_on',
    alarm_control_panel: 'security', update: 'system_update', sun: 'wb_sunny', zone: 'place',
    timer: 'timer', calendar: 'calendar_month', todo: 'checklist', input_number: 'pin',
    input_select: 'checklist', input_text: 'text_fields',
  };
  // 分类图标白名单 —— 与 server/services/haDomains.js 的 CATEGORY_ICONS 逐项一致
  const HA_CATEGORY_ICONS = [
    'home', 'lightbulb', 'curtains', 'photo_camera', 'air', 'device_thermostat',
    'tv', 'speaker', 'lock', 'sensors', 'water_drop', 'hot_tub', 'power_settings_new',
    'cleaning_services', 'security', 'kitchen', 'garage', 'yard', 'directions_car', 'pets',
  ];
  const HA_ENV_ICONS = { temp: 'thermostat', humid: 'water_drop', batt: 'battery_full' };
  const HA_POWER_KEYS = ['current_power_w', 'current_power', 'power', 'active_power', 'instantaneous_power', 'load_power', 'apparent_power', 'power_consumption'];

  const HaPanel = {
    template: `
    <div class="ha-panel">
      <div class="ha-sub">
        <button :class="{ on: sub === 'dash' }" @click="sub = 'dash'">仪表盘</button>
        <button :class="{ on: sub === 'cfg' }" @click="sub = 'cfg'">配置</button>
        <button :class="{ on: sub === 'dev' }" @click="sub = 'dev'">设备</button>
      </div>
      <div v-if="err" class="alert err">{{ err }}</div>
      <div v-if="okMsg" class="alert ok">{{ okMsg }}</div>

      <!-- 仪表盘 -->
      <template v-if="sub === 'dash'">
        <div v-if="cfg && !wsOn" class="muted ha-dash-hint">
          <template v-if="cfg.has_token">Home Assistant 未连接{{ cfg.ws && cfg.ws.last_error ? '（' + cfg.ws.last_error + '）' : '' }}——</template>
          <template v-else>还没配置 Home Assistant 连接——</template>
          <a href="javascript:void(0)" @click="sub = 'cfg'">去【配置】页处理</a>
        </div>

        <div class="ha-dash-wrap">
          <div class="ha-rail">
            <button class="ha-rail-btn" :class="{ on: dashTab === '' }" title="全部" @click="dashTab = ''">
              <span class="material-icons">apps</span>
            </button>
            <button v-for="c in ents.cats" :key="c.id" class="ha-rail-btn" :class="{ on: dashTab === c.id }" :title="c.name" @click="dashTab = c.id">
              <span class="material-icons">{{ c.icon }}</span>
            </button>
          </div>

          <div class="ha-dash-main">
            <div v-if="loading && !ents.entities.length" class="muted" style="text-align:center;padding:32px">正在拉取设备…</div>
            <div v-else-if="!ents.entities.length" class="muted" style="text-align:center;padding:32px">
              {{ cfg && cfg.has_token ? 'HA 里还没有实体' : '先到【配置】页填地址与长期访问令牌' }}
            </div>
            <div v-else-if="!dashItems.length" class="muted" style="text-align:center;padding:32px">
              {{ dashTab
                ? '这个分类下还没有可见设备——到【设备】页把设备勾选「仪表盘可见」并归入分类'
                : '仪表盘默认不展示任何设备——勾选过的设备才会出现在这里' }}
              <div style="margin-top:10px;display:flex;gap:8px;justify-content:center;flex-wrap:wrap">
                <button v-if="isAdmin" class="btn sm" :disabled="addingAll" @click="showAllDash">{{ addingAll ? '正在加入…' : '全部设备加入仪表盘' }}</button>
                <button class="btn sm" @click="sub = 'dev'">去设备页配置</button>
              </div>
            </div>

            <div v-else class="ha-dcards">
              <div v-for="it in dashItems" :key="it.key" :data-dk="it.key" class="ha-card-unit"
                :class="{ dragging: dragKey === it.key, gone: !it.rows.length }">
                <span v-if="isAdmin && it.rows.length" class="ha-grip material-icons"
                  title="拖动排序" @pointerdown="dragStart(it.key, $event)">drag_indicator</span>
                <!-- 电脑卡片（v1.0.28）：pc_switch 实体所在的设备——不显示参数，只留开关机与状态 -->
                <div v-if="it.isPc && it.pcEnt" class="ha-pc-card" @click="openDetail(it.pcEnt)">
                  <span class="material-icons ha-pc-ic" :class="{ on: it.pcEnt.on }">power_settings_new</span>
                  <div class="ha-name" :title="it.pcEnt.entity_id">{{ it.title }}</div>
                  <div class="ha-state" :class="{ on: it.pcEnt.on }">{{ it.pcEnt.online ? (it.pcEnt.on ? '已开机' : '已关机') : '不可用' }}</div>
                  <button v-if="it.pcEnt.controllable && it.pcEnt.online" class="ha-toggle pc"
                    :class="{ on: it.pcEnt.on, busy: toggling[it.pcEnt.entity_id] }"
                    :title="it.pcEnt.on ? '点击关机' : '点击开机'" @click.stop="toggle(it.pcEnt)"><span></span></button>
                </div>
                <template v-else-if="it.kind === 'ent' && it.rows[0]">
                  <div class="ha-ent-inner" @click="openDetail(it.rows[0])">
                    <img v-if="it.rows[0].domain === 'camera' && it.rows[0].online" class="ha-cam" :src="camUrl(it.rows[0])"
                      @error="it.rows[0].online = false" @click.stop="camTick++" @dblclick.stop="zoomCam = it.rows[0]" alt="" />
                    <div v-else-if="isBigVal(it.rows[0])" class="ha-big ent">
                      <b>{{ bigNum(it.rows[0]) }}<i v-if="it.rows[0].unit">{{ it.rows[0].unit }}</i></b>
                      <span class="muted">{{ it.rows[0].name }}</span>
                      <span class="muted ha-big-hint">点击看 24 小时趋势</span>
                    </div>
                    <div v-else-if="it.view.nums.length" class="ha-bigs ent-nums">
                      <div v-for="(n, i) in it.view.nums" :key="i" class="ha-big">
                        <b><span v-if="n.icon" class="material-icons ha-num-ic">{{ n.icon }}</span>{{ n.val }}<i v-if="n.unit">{{ n.unit }}</i></b>
                        <span class="muted">{{ n.label }}</span>
                      </div>
                    </div>
                    <template v-else>
                      <span class="material-icons ha-icon">{{ iconOf(it.rows[0]) }}</span>
                      <div class="ha-name" :title="it.rows[0].entity_id">{{ it.rows[0].name }}</div>
                      <div class="ha-state" :class="{ on: it.rows[0].on }">{{ it.rows[0].online ? it.rows[0].state_text : '不可用' }}<span v-if="it.rows[0].unit" class="muted"> · {{ it.rows[0].unit }}</span></div>
                    </template>
                    <div v-if="it.view.bar" class="ha-posbar" :title="'已开 ' + it.view.bar.pct + '%'">
                      <span class="ha-posbar-track"><span class="ha-posbar-fill" :style="{ width: it.view.bar.pct + '%' }"></span></span>
                      <span class="ha-posbar-txt">{{ it.view.bar.pct }}%</span>
                    </div>
                    <button v-if="it.rows[0].controllable && it.rows[0].online" class="ha-toggle" :class="{ on: it.rows[0].on, busy: toggling[it.rows[0].entity_id] }"
                      :title="it.rows[0].on ? '点击关闭' : '点击开启'" @click.stop="toggle(it.rows[0])"><span></span></button>
                  </div>
                </template>
                <template v-else-if="it.rows.length">
                  <div class="ha-dcard-head">
                    <b :title="'查看 ' + it.title + ' 详情'" @click="it.view.primary && openDetail(it.view.primary)">{{ it.title }}</b>
                    <span class="muted">{{ it.area }}</span>
                  </div>
                  <button v-if="it.view.single" class="ha-toggle" :class="{ on: it.view.single.on, busy: toggling[it.view.single.entity_id] }"
                    :title="it.view.single.on ? '点击关闭' : '点击开启'" @click.stop="toggle(it.view.single)"><span></span></button>
                  <div class="ha-dbody">
                    <div v-for="r in it.view.cams" :key="r.entity_id" class="ha-camwrap">
                      <img class="ha-cam" :src="camUrl(r)" @error="r.online = false" @click.stop="camTick++" @dblclick.stop="zoomCam = r" title="点击刷新画面，双击放大" alt="" />
                    </div>
                    <div v-if="it.view.nums.length" class="ha-bigs">
                      <div v-for="(n, i) in it.view.nums" :key="i" class="ha-big" title="点击看详情" @click="openDetail(n.e)">
                        <b><span v-if="n.icon" class="material-icons ha-num-ic">{{ n.icon }}</span>{{ n.val }}<i v-if="n.unit">{{ n.unit }}</i></b>
                        <span class="muted">{{ n.label }}</span>
                      </div>
                    </div>
                    <div v-if="it.view.bar" class="ha-posbar" :title="'已开 ' + it.view.bar.pct + '%'">
                      <span class="ha-posbar-track"><span class="ha-posbar-fill" :style="{ width: it.view.bar.pct + '%' }"></span></span>
                      <span class="ha-posbar-txt">{{ it.view.bar.pct }}%</span>
                    </div>
                    <div v-if="it.view.hero" class="ha-hero" @click="openDetail(it.view.hero)">
                      <span class="material-icons" :class="{ on: it.view.hero.on }">{{ iconOf(it.view.hero) }}</span>
                      <b :class="{ on: it.view.hero.on }">{{ it.view.hero.online ? it.view.hero.state_text : '不可用' }}</b>
                    </div>
                    <div v-if="it.view.sws.length > 1" class="ha-swrow">
                      <div v-for="r in it.view.sws" :key="r.entity_id" class="ha-sw" @click="openDetail(r)">
                        <button class="ha-toggle sm" :class="{ on: r.on, busy: toggling[r.entity_id] }"
                          :title="r.on ? '点击关闭' : '点击开启'" @click.stop="toggle(r)"><span></span></button>
                        <span class="ha-sw-name" :title="r.entity_id">{{ r.name }}</span>
                      </div>
                    </div>
                  </div>
                </template>
                <div v-else class="muted" style="font-size:12px;padding:8px 4px">设备已不在线上清单里——到【设备】页取消可见</div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- 配置 -->
      <template v-else-if="sub === 'cfg'">
        <div class="card ha-status">
          <span class="ha-dot" :class="{ on: wsOn }"></span>
          <b>{{ wsOn ? '已连接' : '未连接' }}</b>
          <span v-if="cfg" class="muted">
            · {{ cfg.config.url || '未配内网地址' }}<template v-if="cfg.config.url_external"> / {{ cfg.config.url_external }}</template>
          </span>
          <span v-if="onExternal" class="ha-warn" :title="'内网地址连不上，当前实际走 ' + (cfg.ws.url || '')">· 正走外网地址（内网未通）</span>
          <span v-if="cfg && cfg.version" class="muted">· HA {{ cfg.version }}<template v-if="cfg.location_name"> · {{ cfg.location_name }}</template></span>
          <label v-if="hasCamera" class="ha-radio" title="开启后摄像头缩略图每 15 秒自动刷新（全局生效）；关闭后点图片仍可手动刷新"><input type="checkbox" v-model="camAuto" />摄像头画面自动刷新</label>
          <span style="flex:1"></span>
          <button class="btn sm" :disabled="loading" @click="loadAll(true)">{{ loading ? '刷新中…' : '刷新' }}</button>
        </div>
        <div v-if="cfg && !wsOn && cfg.ws && cfg.ws.last_error" class="alert err">WebSocket：{{ cfg.ws.last_error }}（实体一览仍可用 REST 轮询，实时推送要连上才生效）</div>

        <div v-if="isAdmin" class="card">
          <h3 style="margin:0 0 12px">连接配置</h3>
          <div v-if="!cfg" class="muted" style="padding:8px 0">加载中…</div>
          <template v-else>
            <div class="ha-form">
              <label>内网地址（局域网直连，优先使用）</label>
              <input v-model="form.url" placeholder="http://192.168.110.105:8123" />
              <label>外网地址（可选；内网不通时自动改走这里）</label>
              <input v-model="form.url_external" placeholder="https://ha.example.com" />
              <label>长期访问令牌（LLAT）</label>
              <input type="password" v-model="form.token" autocomplete="new-password"
                :placeholder="cfg.has_token ? '已保存（留空 = 保持不变）' : 'HA 左下角头像 → 安全 → 长期访问令牌 → 创建令牌'" />
              <label>电脑开关实体（仪表盘里它所在的设备卡片将简化为 只显示开关机与状态；留空 = 不简化）</label>
              <input v-model="form.pc_switch" list="ha-pc-cands" placeholder="如 switch.pc（可下拉选，也可手填）" />
              <datalist id="ha-pc-cands">
                <option v-for="e in pcCandidates" :key="e.entity_id" :value="e.entity_id">{{ e.name }}</option>
              </datalist>
              <label>注册表缓存（分钟）——区域/设备/实体清单的有效期</label>
              <input v-model.number="form.cache_ttl_min" type="number" min="1" max="1440" style="max-width:120px" />
              <div class="ha-row">
                <button class="btn sm" :disabled="testing" @click="doTest">{{ testing ? '测试中…' : '测试连接（可用未保存的值）' }}</button>
                <button class="btn" :disabled="saving" @click="doSave">{{ saving ? '保存中…' : '保存配置' }}</button>
              </div>
              <div v-if="testResult" :class="testResult.ok ? 'alert ok' : 'alert err'">
                {{ testResult.ok
                  ? '连通：' + testResult.base + (testResult.version ? ' · HA ' + testResult.version : '') + ' · ' + testResult.latency_ms + 'ms'
                  : testResult.error }}
              </div>
            </div>

            <hr class="ha-hr" />
            <h3 style="margin:0 0 6px">Webhook 反向回调</h3>
            <p class="muted" style="margin:0 0 8px;font-size:13px">
              把下面的地址填进 HA 自动化的 RESTful 动作（方法 POST、JSON 里带 title/message），HA 那边的事件就会实时出现在下方「事件」区。
              key 即凭证，免登录但仅登记事件——不在衍像里执行任何动作。
            </p>
            <div class="ha-row">
              <input class="ha-hook" readonly :value="cfg.hook_url" @focus="$event.target.select()" />
              <button class="btn sm" @click="copyHook">复制</button>
              <button class="btn sm danger" @click="rotateHook">轮换 key</button>
            </div>
          </template>
        </div>
        <div v-else-if="cfg" class="card muted" style="font-size:13px">连接配置由管理员维护。</div>

        <div v-if="isAdmin" class="card">
          <h3 style="margin:0 0 6px">服务调用（调试）</h3>
          <p class="muted" style="margin:0 0 10px;font-size:13px">
            直接调 HA 的任意服务（等价于 HA 开发者工具 → 服务）。仪表盘按键已经覆盖常用场景，这里是兜底——调亮度/色温/温度目标值等。
          </p>
          <div v-if="!services.length" class="ha-row">
            <button class="btn sm" :disabled="svcLoading" @click="loadServices">{{ svcLoading ? '载入中…' : '载入服务目录' }}</button>
          </div>
          <template v-else>
            <div class="ha-row">
              <select v-model="svcForm.domain" style="max-width:180px">
                <option v-for="d in svcDomains" :key="d" :value="d">{{ d }}</option>
              </select>
              <select v-model="svcForm.service" style="max-width:220px">
                <option v-for="s in svcServices" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <textarea v-model="svcForm.data" rows="3" class="ha-json" placeholder='服务数据 JSON，如 {"entity_id": "light.ceiling", "brightness": 128}'></textarea>
            <div class="ha-row" style="margin-top:8px">
              <button class="btn sm" :disabled="svcBusy" @click="runService">{{ svcBusy ? '执行中…' : '执行' }}</button>
              <span v-if="svcResult" :class="svcResult.ok ? 'muted' : 'ha-err'" style="font-size:12px">{{ svcResult.text }}</span>
            </div>
          </template>
        </div>

        <div class="card">
          <div class="ha-toolbar">
            <h3 style="margin:0;font-size:15px">事件</h3>
            <label class="ha-radio"><input type="checkbox" v-model="liveOn" />实时推送{{ liveOn ? '' : '（关闭）' }}</label>
            <span style="flex:1"></span>
            <button class="btn sm" @click="loadHooklog">刷新流水</button>
          </div>
          <div v-if="!liveEvents.length && !hookEvents.length" class="muted" style="font-size:13px;padding:8px 0">
            还没有事件：状态变化（开了个灯、温度变了）会实时出现在这里；HA 自动化打 webhook 也会留一条流水。
          </div>
          <div v-for="ev in mergedEvents" :key="ev.k" class="ha-evt">
            <span class="ha-evt-time">{{ fmtTime(ev.ts) }}</span>
            <span class="ha-evt-tag" :class="ev.source">{{ ev.tag }}</span>
            <span style="flex:1">{{ ev.text }}</span>
          </div>
        </div>
      </template>

      <!-- 设备 -->
      <template v-else>
        <div v-if="isAdmin" class="card">
          <div class="ha-toolbar">
            <h3 style="margin:0;font-size:15px">设备分类</h3>
            <span class="muted" style="font-size:12px">分类会变成仪表盘左侧的书签页签（只显图标，悬浮出名称）</span>
            <span style="flex:1"></span>
            <button class="btn sm" @click="addCat">＋ 新增分类</button>
            <button class="btn sm" :disabled="!catDirty || savingCats" @click="saveCats">{{ savingCats ? '保存中…' : catDirty ? '保存分类' : '已保存' }}</button>
          </div>
          <div v-if="!catDraft.length" class="muted" style="font-size:13px;padding:6px 0">还没有分类——新增几个（如「灯光」「窗帘」「摄像头」），再到下面给设备归类。</div>
          <div v-for="(c, i) in catDraft" :key="i" class="ha-cat-row">
            <button class="ha-cat-ic" :title="'换图标（当前 ' + c.icon + '）'" @click="iconPicker = iconPicker === i ? -1 : i">
              <span class="material-icons">{{ c.icon }}</span>
            </button>
            <input v-model="c.name" maxlength="16" placeholder="分类名称（1~16 字）" style="max-width:220px" />
            <span class="muted" style="font-size:12px">图标与名称确定后记得右上「保存分类」</span>
            <span style="flex:1"></span>
            <button class="btn sm danger" @click="delCat(i)">删除</button>
            <div v-if="iconPicker === i" class="ha-icon-grid">
              <button v-for="ic in HA_CATEGORY_ICONS" :key="ic" type="button" :class="{ on: c.icon === ic }" :title="ic" @click="c.icon = ic; iconPicker = -1">
                <span class="material-icons">{{ ic }}</span>
              </button>
            </div>
          </div>
        </div>
        <div v-else-if="ents.cats && ents.cats.length" class="card muted" style="font-size:13px">
          设备分类由管理员维护，当前 {{ ents.cats.length }} 个：{{ ents.cats.map((c) => c.name).join('、') }}。
        </div>

        <div class="card">
          <div class="ha-toolbar">
            <input v-model="devQ" placeholder="搜索设备 / 实体 / entity_id" style="flex:1;min-width:160px" />
            <select v-model="devArea">
              <option value="">全部区域</option>
              <option v-for="a in ents.areas" :key="a.area_id" :value="a.area_id">{{ a.name }}（{{ a.count }}）</option>
              <option value="__none__">未分区</option>
            </select>
            <label class="ha-radio"><input type="checkbox" v-model="devOnlyCtl" />只看可控</label>
            <span class="muted" style="font-size:13px">{{ devGroups.length }} 个{{ devOnlyCtl ? '可控' : '' }}设备/单实体 · {{ entCount }} 个实体</span>
            <span style="flex:1"></span>
            <button class="btn sm" :disabled="loading" @click="loadAll(true)">{{ loading ? '刷新中…' : '刷新' }}</button>
          </div>
          <div v-if="ents.degraded" class="muted" style="font-size:12px;margin-bottom:8px">
            注册表缓存为降级状态（WebSocket 拿不到区域清单，实体归「未分区」）——点右上「刷新」重试。
          </div>

          <div v-if="loading && !ents.entities.length" class="muted" style="text-align:center;padding:24px">正在拉取实体…</div>
          <div v-else-if="!ents.entities.length" class="muted" style="text-align:center;padding:24px">
            {{ cfg && cfg.has_token ? 'HA 里还没有实体' : '先到【配置】页（管理员）配置地址与令牌' }}
          </div>
          <div v-else-if="!devGroups.length" class="muted" style="text-align:center;padding:24px">没有匹配筛选条件的设备</div>

          <div v-else class="ha-devlist">
            <div v-for="b in devGroups" :key="b.key" class="ha-devbox">
              <div class="ha-devbox-head">
                <span class="material-icons ha-devbox-tag" :title="b.kind === 'dev' ? '同一设备的实体框在一起' : '无设备归属的单实体'">{{ b.kind === 'dev' ? 'device_hub' : 'widgets' }}</span>
                <b>{{ b.title }}</b>
                <span v-if="b.sub" class="muted" style="font-size:12px">{{ b.sub }}</span>
                <span class="ha-area-tag">{{ b.area }}</span>
                <span style="flex:1"></span>
                <template v-if="isAdmin">
                  <label class="ha-radio" title="勾上后这个设备（及其全部实体）出现在仪表盘；默认不可见"><input type="checkbox" :checked="dashOf(b.key).visible" @change="setDash(b.key, { visible: $event.target.checked })" />仪表盘可见</label>
                  <select :value="dashOf(b.key).cat" title="归入哪个分类（仪表盘左侧书签）" @change="setDash(b.key, { cat: $event.target.value })">
                    <option value="">（不分类）</option>
                    <option v-for="c in ents.cats" :key="c.id" :value="c.id">{{ c.name }}</option>
                  </select>
                </template>
                <span v-else-if="dashOf(b.key).visible" class="muted" style="font-size:12px">已在仪表盘{{ dashOf(b.key).cat ? ' · ' + catName(dashOf(b.key).cat) : '' }}</span>
              </div>
              <div v-for="r in b.rows" :key="r.entity_id" class="ha-crow" :class="{ hiddenRow: r.hidden }" @click="openDetail(r)">
                <span v-if="r.hidden" class="ha-hidden-tag">隐藏</span>
                <span class="material-icons ha-crow-ic">{{ iconOf(r) }}</span>
                <span class="ha-crow-name" :title="r.entity_id">{{ r.name }}</span>
                <span class="ha-crow-state" :class="{ on: r.on }">{{ r.online ? r.state_text : '不可用' }}<template v-if="r.unit"> · {{ r.unit }}</template></span>
                <button v-if="r.controllable && r.online" class="ha-toggle sm" :class="{ on: r.on, busy: toggling[r.entity_id] }"
                  :title="r.on ? '点击关闭' : '点击开启'" @click.stop="toggle(r)"><span></span></button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- 实体详情弹层 -->
      <div v-if="detail" class="ha-mask" @click.self="closeDetail">
        <div class="ha-modal">
          <div class="ha-modal-head">
            <b>{{ detail.e.name }}</b>
            <span class="muted" style="font-size:12px">{{ detail.e.entity_id }}</span>
            <span style="flex:1"></span>
            <button class="btn sm" @click="closeDetail">关闭</button>
          </div>
          <div class="ha-modal-body">
            <div v-if="detail.e.domain === 'camera' && detail.e.online" class="ha-detail-cam">
              <img :src="camUrl(detail.e)" @error="detail.e.online = false" @click="camTick++" @dblclick="zoomCam = detail.e" alt="" />
              <div class="muted" style="font-size:12px;margin-top:4px">点图片刷新当前帧，双击放大{{ camAuto ? '（已开自动刷新，每 15 秒）' : '（自动刷新在【配置】页关闭着）' }}</div>
            </div>
            <div class="ha-kv"><span>状态</span><b :class="{ on: detail.e.on }">{{ detail.e.state_text }}</b></div>
            <div class="ha-kv"><span>区域</span><b>{{ detail.e.area }}</b></div>
            <div class="ha-kv"><span>类型</span><b>{{ detail.e.label }}（{{ detail.e.domain }}）</b></div>
            <div v-if="detail.e.device_name" class="ha-kv"><span>所属设备</span><b>{{ detail.e.device_name }}</b></div>
            <div class="ha-kv"><span>最后变化</span><b>{{ detail.e.last_changed ? new Date(detail.e.last_changed).toLocaleString() : '—' }}</b></div>

            <h4 style="margin:14px 0 6px">近 24 小时</h4>
            <div v-if="detail.histLoading" class="muted" style="font-size:13px">加载中…</div>
            <svg v-else-if="detail.points && detail.points.length > 1" viewBox="0 0 280 64" class="ha-spark">
              <polyline :points="sparkPoints" fill="none" stroke="var(--primary, #4f8cff)" stroke-width="1.5" />
            </svg>
            <div v-else class="muted" style="font-size:13px">无历史记录</div>

            <h4 style="margin:14px 0 6px">属性</h4>
            <div class="ha-attrs">
              <div v-for="(v, k) in detail.e.attributes" :key="k" class="ha-attr">
                <span>{{ k }}</span><b>{{ attrText(v) }}</b>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 监控截图放大层 -->
      <div v-if="zoomCam" class="ha-zoom" title="点击任意处关闭" @click="zoomCam = null">
        <img :src="camUrl(zoomCam)" @error="zoomCam.online = false" alt="" />
        <div class="ha-zoom-cap">{{ zoomCam.name }}<span class="muted" style="color:#ccc">（点击任意处关闭）</span></div>
      </div>
    </div>`,
    data() {
      return {
        sub: 'dash', dashTab: '',
        cfg: null, isAdmin: !!(store.user && store.user.role === 'admin'),
        form: { url: '', url_external: '', token: '', cache_ttl_min: 5, pc_switch: '' },
        testing: false, saving: false, testResult: null,
        err: '', okMsg: '', loading: false,
        ents: { entities: [], areas: [], at: 0, degraded: false, devices: [], cats: [], dash: {} },
        toggling: {},
        camTick: 0, camAuto: localStorage.getItem('ha_cam_auto') !== '0',
        zoomCam: null,
        services: [], svcLoading: false, svcBusy: false,
        svcForm: { domain: '', service: '', data: '{}' }, svcResult: null,
        liveOn: true, liveEvents: [], hookEvents: [],
        detail: null,
        dragKey: '', addingAll: false,
        devQ: '', devArea: '', devOnlyCtl: false,
        catDraft: [], iconPicker: -1, savingCats: false,
        HA_CATEGORY_ICONS,
      };
    },
    computed: {
      wsOn() { return !!(this.cfg && this.cfg.ws && this.cfg.ws.connected); },
      // 远程开机：pc_switch 已配置的实体 id（其所在仪表盘卡片渲染为极简电脑卡）/ 配置候选清单
      pcId() { return String((this.cfg && this.cfg.config && this.cfg.config.pc_switch) || '').trim(); },
      pcCandidates() {
        const rank = { switch: 0, input_boolean: 1, light: 2 };
        return this.ents.entities
          .filter((e) => e.controllable && !e.hidden && rank[e.domain] !== undefined)
          .sort((a, b) => (rank[a.domain] - rank[b.domain]) || a.name.localeCompare(b.name, 'zh'))
          .slice(0, 80);
      },
      onExternal() {
        const c = this.cfg;
        if (!c || !c.ws || !c.ws.connected) return false;
        const norm = (s) => String(s || '').trim().replace(/\/+$/, '');
        const cur = norm(c.ws.url), inner = norm(c.config.url);
        return !!inner && !!cur && cur !== inner;
      },
      hasCamera() { return this.ents.entities.some((e) => e.domain === 'camera' && e.online); },
      dashItems() {
        const d = this.ents.dash || {};
        const out = Object.entries(d)
          .filter(([k, v]) => v && v.visible === true && (!this.dashTab || v.cat === this.dashTab))
          .map(([k, v]) => ({ ...this.cardOf(k), sort: v.sort || 0 }));
        out.sort((a, b) => a.sort - b.sort || (a.key < b.key ? -1 : 1));
        return out;
      },
      devGroups() {
        const kw = this.devQ.trim().toLowerCase();
        const areaOk = (aid, aname) => {
          if (!this.devArea) return true;
          if (this.devArea === '__none__') return !aid || aname === '未分区';
          return aid === this.devArea;
        };
        const boxes = [];
        for (const d of this.ents.devices || []) {
          const rows = this.ents.entities.filter((e) => e.device_id === d.id);
          if (!rows.length) continue;
          if (!areaOk(d.area_id, d.area)) continue;
          if (this.devOnlyCtl && !rows.some((e) => e.controllable)) continue;
          if (kw && !(
            d.name.toLowerCase().includes(kw) || d.manufacturer.toLowerCase().includes(kw) || d.model.toLowerCase().includes(kw)
            || rows.some((e) => e.name.toLowerCase().includes(kw) || e.entity_id.toLowerCase().includes(kw))
          )) continue;
          boxes.push({ kind: 'dev', key: 'dev:' + d.id, title: d.name, sub: [d.manufacturer, d.model].filter(Boolean).join(' '), area: d.area, rows });
        }
        for (const e of this.ents.entities.filter((x) => !x.device_id)) {
          if (!areaOk(e.area_id, e.area)) continue;
          if (this.devOnlyCtl && !e.controllable) continue;
          if (kw && !(e.name.toLowerCase().includes(kw) || e.entity_id.toLowerCase().includes(kw))) continue;
          boxes.push({ kind: 'ent', key: 'ent:' + e.entity_id, title: e.name, sub: '', area: e.area, rows: [e] });
        }
        boxes.sort((a, b) => (a.area === b.area ? a.title.localeCompare(b.title, 'zh') : a.area.localeCompare(b.area, 'zh')));
        return boxes;
      },
      entCount() { return this.devGroups.reduce((s, b) => s + b.rows.length, 0); },
      catDirty() { return JSON.stringify(this.catDraft) !== JSON.stringify(this.ents.cats || []); },
      svcDomains() { return [...new Set(this.services.map((s) => s.domain))].sort(); },
      svcServices() {
        const d = this.services.find((s) => s.domain === this.svcForm.domain);
        return d ? Object.keys(d.services || {}) : [];
      },
      mergedEvents() {
        const a = this.liveEvents.map((e) => ({ ...e }));
        const ids = new Set(a.map((e) => e.ts + e.text));
        const b = this.hookEvents.filter((e) => !ids.has(e.ts + [e.title, e.message].filter(Boolean).join('：')))
          .map((e) => ({ ts: e.ts, source: e.source, tag: e.source === 'hook' ? 'HA' : '控制', k: 'd' + e.id, text: [e.title, e.message].filter(Boolean).join('：') }));
        return [...a, ...b].sort((x, y) => y.ts - x.ts).slice(0, 60);
      },
      sparkPoints() {
        const pts = this.detail && this.detail.points;
        if (!pts || pts.length < 2) return '';
        const nums = pts.map((p) => {
          const n = Number(p.state);
          if (Number.isFinite(n)) return n;
          const s = String(p.state).toLowerCase();
          return s === 'on' || s === 'open' || s === 'opening' || s === 'playing' ? 1 : 0;
        });
        const min = Math.min(...nums), max = Math.max(...nums);
        const span = max - min || 1;
        const t0 = new Date(pts[0].last_changed).getTime() || 0;
        const t1 = new Date(pts[pts.length - 1].last_changed).getTime() || 1;
        const spanT = t1 - t0 || 1;
        return pts.map((p, i) => {
          const x = ((new Date(p.last_changed).getTime() - t0) / spanT) * 276 + 2;
          const y = 60 - ((nums[i] - min) / span) * 54 - 2;
          return x.toFixed(1) + ',' + y.toFixed(1);
        }).join(' ');
      },
    },
    watch: {
      camAuto(v) { localStorage.setItem('ha_cam_auto', v ? '1' : '0'); },
      'ents.cats': {
        immediate: true,
        handler(v) { this.catDraft = (v || []).map((c) => ({ id: c.id, name: c.name, icon: c.icon })); },
      },
      'svcForm.domain'() {
        const list = this.svcServices;
        this.svcForm.service = list.includes('turn_on') ? 'turn_on' : list[0] || '';
      },
      liveOn(on) { on ? this.openSse() : this.closeSse(); },
    },
    methods: {
      authed,
      camUrl(e) { return authed('/api/ha/camera/' + encodeURIComponent(e.entity_id)) + '&t=' + this.camTick; },
      iconOf(e) { return HA_ICONS[e.domain] || 'widgets'; },
      catName(id) { const c = (this.ents.cats || []).find((x) => x.id === id); return c ? c.name : ''; },
      flashOk(m) { this.okMsg = m; setTimeout(() => { if (this.okMsg === m) this.okMsg = ''; }, 4000); },
      fmtTime(ts) {
        const d = new Date(ts);
        const p = (n) => String(n).padStart(2, '0');
        return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
      },
      isBigVal(e) { return e.domain === 'sensor' && e.online && String(e.state).trim() !== '' && Number.isFinite(Number(e.state)); },
      bigNum(e) { return String(Number(e.state)); },
      envKind(e) {
        if (!e.online || e.domain !== 'sensor') return '';
        const a = e.attributes || {};
        const dc = String(a.device_class || '').toLowerCase();
        const unit = String(a.unit_of_measurement || '');
        const nm = String(e.name || '');
        if (dc === 'battery' || /电量|电池/.test(nm) || /battery/i.test(nm)) return 'batt';
        if (dc === 'temperature' || /°[CF]|℃/.test(unit)) return 'temp';
        if (dc === 'humidity' || /湿度/.test(nm)) return 'humid';
        return '';
      },
      watts(e) {
        const a = (e && e.attributes) || {};
        for (const k of HA_POWER_KEYS) { const n = Number(a[k]); if (Number.isFinite(n)) return n; }
        return null;
      },
      posOf(e) {
        const a = (e && e.attributes) || {};
        for (const k of ['current_position', 'position']) {
          const n = Number(a[k]);
          if (Number.isFinite(n)) return Math.max(0, Math.min(100, Math.round(n)));
        }
        return null;
      },
      climateNums(e) {
        const a = (e && e.attributes) || {};
        const out = [];
        for (const [k, label, unit] of [['temperature', '目标温度', '°C'], ['humidity', '目标湿度', '%'], ['current_temperature', '当前室温', '°C']]) {
          const n = Number(a[k]);
          if (Number.isFinite(n)) out.push({ icon: '', label, val: n, unit, e });
        }
        return out;
      },
      buildView(rows) {
        const ctl = rows.filter((r) => r.controllable && r.online);
        const swsOf = (pref) => {
          const hit = pref ? ctl.filter((r) => pref.includes(r.domain)) : ctl;
          return hit.length ? hit : ctl;
        };
        let v;
        const cams = rows.filter((r) => r.domain === 'camera' && r.online);
        if (cams.length) {
          v = { cls: 'camera', cams, nums: [], bar: null, sws: swsOf(['switch', 'input_boolean']).slice(0, 1) };
        } else if (rows.some((r) => r.domain === 'climate')) {
          v = { cls: 'climate', cams: [], nums: this.climateNums(rows.find((r) => r.domain === 'climate')), bar: null, sws: swsOf(['climate']) };
        } else if (rows.some((r) => r.domain === 'cover')) {
          const cov = rows.find((r) => r.domain === 'cover');
          const pct = this.posOf(cov);
          v = { cls: 'cover', cams: [], nums: [], bar: pct == null ? null : { pct }, sws: swsOf(['cover']) };
        } else if (rows.some((r) => r.domain === 'light')) {
          v = { cls: 'light', cams: [], nums: [], bar: null, sws: swsOf(['light', 'switch', 'input_boolean']) };
        } else if (rows.some((r) => this.watts(r) != null)) {
          const plugs = rows.filter((r) => this.watts(r) != null);
          v = {
            cls: 'plug', cams: [], bar: null, sws: swsOf(['switch', 'light', 'input_boolean']),
            nums: plugs.map((r) => ({ icon: 'bolt', label: plugs.length > 1 ? r.name : '功率', val: this.watts(r), unit: 'W', e: r })),
          };
        } else if (rows.some((r) => this.envKind(r))) {
          const env = rows.map((r) => ({ r, k: this.envKind(r) })).filter((x) => x.k);
          v = { cls: 'env', cams: [], bar: null, sws: [], nums: env.map((x) => ({ icon: HA_ENV_ICONS[x.k], label: x.r.name, val: Number(x.r.state), unit: x.r.unit || (x.k === 'batt' ? '%' : ''), e: x.r })) };
        } else {
          v = { cls: 'plain', cams: [], bar: null, sws: ctl, nums: rows.filter((r) => this.isBigVal(r)).map((r) => ({ icon: '', label: r.name, val: Number(r.state), unit: r.unit || '', e: r })) };
        }
        v.single = v.sws.length === 1 ? v.sws[0] : null;
        v.hero = !v.cams.length && !v.nums.length && !v.bar && v.sws.length <= 1
          ? (v.single || ctl[0] || rows.find((r) => r.online) || rows[0] || null) : null;
        v.primary = v.cams[0] || v.single || ctl[0] || (v.nums[0] && v.nums[0].e) || rows[0] || null;
        return v;
      },
      cardOf(k) {
        if (k.startsWith('dev:')) {
          const id = k.slice(4);
          const d = (this.ents.devices || []).find((x) => x.id === id);
          const rows = this.ents.entities.filter((e) => e.device_id === id && !e.hidden);
          const pcEnt = this.pcId ? (rows.find((r) => r.entity_id === this.pcId) || null) : null;
          return { kind: 'dev', key: k, title: (d && d.name) || (rows[0] && rows[0].device_name) || id, area: (d && d.area) || '', rows, view: this.buildView(rows), isPc: !!pcEnt, pcEnt };
        }
        const e = this.ents.entities.find((x) => x.entity_id === k.slice(4));
        const rows = e && !e.hidden ? [e] : [];
        const pcEnt = this.pcId && e && e.entity_id === this.pcId ? e : null;
        return { kind: 'ent', key: k, title: e ? e.name : k.slice(4), area: e ? e.area : '', rows, view: this.buildView(rows), isPc: !!pcEnt, pcEnt };
      },
      dragStart(k, ev) {
        if (!this.isAdmin || ev.button !== 0) return;
        this.dragKey = k;
        this._dragMoved = false;
        try { ev.currentTarget.setPointerCapture && ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* 老浏览器 */ }
        window.addEventListener('pointermove', this._dragMove);
        window.addEventListener('pointerup', this._dragEnd);
        window.addEventListener('pointercancel', this._dragEnd);
      },
      dragMove(ev) {
        const k = this.dragKey;
        if (!k) return;
        const over = document.elementFromPoint(ev.clientX, ev.clientY);
        const card = over && over.closest ? over.closest('[data-dk]') : null;
        if (!card || card.dataset.dk === k) return;
        if (this.reorderDash(k, card.dataset.dk)) this._dragMoved = true;
      },
      dragEnd() {
        if (!this.dragKey) return;
        this.dragKey = '';
        window.removeEventListener('pointermove', this._dragMove);
        window.removeEventListener('pointerup', this._dragEnd);
        window.removeEventListener('pointercancel', this._dragEnd);
        if (this._dragMoved) this.persistDash();
      },
      reorderDash(fromKey, toKey) {
        const cur = this.ents.dash || {};
        const keys = this.dashItems.map((i) => i.key);
        const from = keys.indexOf(fromKey), to = keys.indexOf(toKey);
        if (from < 0 || to < 0 || from === to) return false;
        keys.splice(to, 0, keys.splice(from, 1)[0]);
        keys.forEach((kk, i) => { if (cur[kk]) cur[kk].sort = i * 10; });
        return true;
      },
      async persistDash() {
        if (!this.isAdmin) return;
        try {
          const r = await api('PUT', '/ha/dashboard', { dashboard: this.ents.dash });
          this.ents.dash = r.dashboard;
        } catch (e) { this.err = e.message; }
      },
      dashOf(key) { return (this.ents.dash || {})[key] || { visible: false, cat: '', sort: 0 }; },
      async setDash(key, patch) {
        if (!this.isAdmin) return;
        const d = this.ents.dash = this.ents.dash || {};
        d[key] = { visible: false, cat: '', sort: 99990, ...(d[key] || {}), ...patch };
        try {
          const r = await api('PUT', '/ha/dashboard', { dashboard: d });
          this.ents.dash = r.dashboard;
          this.flashOk('已保存（仪表盘即时生效）');
        } catch (e) {
          this.err = e.message;
          this.loadEntities(false).catch(() => {});
        }
      },
      async showAllDash() {
        if (!this.isAdmin || this.addingAll) return;
        this.addingAll = true;
        try {
          const d = { ...(this.ents.dash || {}) };
          let next = Math.max(0, ...Object.values(d).map((v) => (v && v.sort) || 0)) + 10;
          const keys = [];
          for (const dev of this.ents.devices || []) {
            if (this.ents.entities.some((e) => e.device_id === dev.id && !e.hidden)) keys.push('dev:' + dev.id);
          }
          for (const e of this.ents.entities) {
            if (!e.device_id && !e.hidden) keys.push('ent:' + e.entity_id);
          }
          let added = 0;
          for (const k of keys) {
            if (Object.keys(d).length >= 500) break;
            if (d[k]) { d[k] = { ...d[k], visible: true }; continue; }
            d[k] = { visible: true, cat: '', sort: next };
            next += 10;
            added++;
          }
          const r = await api('PUT', '/ha/dashboard', { dashboard: d });
          this.ents.dash = r.dashboard;
          this.flashOk(added ? '已全部加入仪表盘（新增 ' + added + ' 项）' : '已把既有条目全部设为可见');
        } catch (e) { this.err = e.message; }
        finally { this.addingAll = false; }
      },
      addCat() { this.catDraft.push({ id: '', name: '', icon: 'home' }); this.iconPicker = this.catDraft.length - 1; },
      delCat(i) { this.catDraft.splice(i, 1); this.iconPicker = -1; },
      async saveCats() {
        this.savingCats = true;
        try {
          await api('PUT', '/ha/categories', { categories: this.catDraft });
          this.flashOk('分类已保存');
          await this.loadEntities(false);
        } catch (e) { this.err = e.message; }
        finally { this.savingCats = false; }
      },
      async loadConfig(intoForm = true) {
        const r = await api('GET', '/ha/config');
        this.cfg = r;
        this.isAdmin = !!r.is_admin;
        if (!intoForm) return;
        this.form.url = r.config.url;
        this.form.url_external = r.config.url_external;
        this.form.cache_ttl_min = r.config.cache_ttl_min;
        this.form.pc_switch = r.config.pc_switch || '';
        this.form.token = '';
      },
      async loadEntities(fresh, silent) {
        try {
          const r = await api('GET', '/ha/entities' + (fresh ? '?fresh=1' : ''));
          this.ents = { devices: [], cats: [], dash: {}, ...r };
        } catch (e) {
          if (silent) return;
          if (!this.ents.entities.length) this.err = e.message;
          else this.err = '刷新失败：' + e.message;
        }
      },
      async loadHooklog() {
        try {
          const r = await api('GET', '/ha/hooklog?limit=30');
          this.hookEvents = r.events || [];
        } catch { /* 静默：事件流水非关键路径 */ }
      },
      async loadAll(fresh) {
        this.err = '';
        this.loading = true;
        try { await Promise.all([this.loadConfig(), this.loadEntities(fresh), this.loadHooklog()]); }
        finally { this.loading = false; }
      },
      async autoEntities(fresh) {
        if (this._entBusy || this.loading || this.dragKey || this.iconPicker !== -1 || this.catDirty) return;
        this._entBusy = true;
        try { await this.loadEntities(fresh, true); } catch { /* 静默 */ }
        finally { this._entBusy = false; }
      },
      async doTest() {
        this.testing = true;
        this.testResult = null;
        try {
          const body = { url: this.form.url, url_external: this.form.url_external };
          if (this.form.token.trim()) body.token = this.form.token.trim();
          this.testResult = await api('POST', '/ha/test', body);
        } catch (e) { this.testResult = { ok: false, error: e.message }; }
        finally { this.testing = false; }
      },
      async doSave() {
        this.saving = true;
        this.err = '';
        try {
          const body = { url: this.form.url, url_external: this.form.url_external, cache_ttl_min: this.form.cache_ttl_min, pc_switch: this.form.pc_switch };
          if (this.form.token.trim()) body.token = this.form.token.trim();
          await api('PUT', '/ha/config', body);
          await this.loadConfig();
          await this.loadEntities(true);
          this.pollWsAfterSave();
          this.flashOk('已保存，并按新配置重连 Home Assistant');
        } catch (e) { this.err = e.message; }
        finally { this.saving = false; }
      },
      pollWsAfterSave(ms = 12000) {
        const t0 = Date.now();
        (async () => {
          while (Date.now() - t0 < ms) {
            await new Promise((r) => setTimeout(r, 1200));
            try { await this.loadConfig(false); } catch { return; }
            if (this.wsOn) return;
          }
        })().catch(() => {});
      },
      async rotateHook() {
        if (!confirm('轮换后旧 key 立即失效，HA 自动化里的地址要同步改。确定轮换？')) return;
        try {
          await api('PUT', '/ha/config', { rotate_hook: true });
          await this.loadConfig();
          this.flashOk('已轮换——把新地址重新填进 HA 自动化');
        } catch (e) { this.err = e.message; }
      },
      copyHook() {
        if (!this.cfg) return;
        navigator.clipboard && navigator.clipboard.writeText(this.cfg.hook_url).then(() => this.flashOk('已复制 webhook 地址'));
      },
      async toggle(e) {
        if (this.toggling[e.entity_id]) return;
        this.toggling[e.entity_id] = true;
        const before = e.on;
        e.on = !before;
        try {
          const r = await api('POST', '/ha/control', { entity_id: e.entity_id, action: 'toggle' });
          if (!r.ok || r.verified === false) { this.err = r.message; }
          else this.flashOk(r.message);
        } catch (ex) { e.on = before; this.err = ex.message; }
        finally {
          delete this.toggling[e.entity_id];
          this.refreshOne(e.entity_id);
        }
      },
      async refreshOne(entityId) {
        try {
          const st = await api('GET', '/ha/entity/' + encodeURIComponent(entityId));
          const e = this.ents.entities.find((x) => x.entity_id === entityId);
          if (e) {
            e.state = st.state;
            e.on = ['on', 'open', 'opening', 'playing'].includes(String(st.state).toLowerCase());
            e.state_text = { on: '开着', off: '关着', open: '开着', closed: '关着', opening: '正在开', closing: '正在关' }[String(st.state).toLowerCase()] || String(st.state);
          }
          if (this.detail && this.detail.e.entity_id === entityId) this.detail.e.state = st.state;
        } catch { /* 下一次全量刷新兜底 */ }
      },
      async loadServices() {
        this.svcLoading = true;
        try {
          const r = await api('GET', '/ha/services');
          this.services = r.services || [];
          if (this.svcDomains.length) this.svcForm.domain = this.svcDomains.includes('light') ? 'light' : this.svcDomains[0];
        } catch (e) { this.err = e.message; }
        finally { this.svcLoading = false; }
      },
      async runService() {
        let data = {};
        try { data = this.svcForm.data.trim() ? JSON.parse(this.svcForm.data) : {}; }
        catch { this.svcResult = { ok: false, text: 'data 不是合法 JSON' }; return; }
        this.svcBusy = true;
        this.svcResult = null;
        try {
          const r = await api('POST', '/ha/service', { domain: this.svcForm.domain, service: this.svcForm.service, data });
          this.svcResult = { ok: true, text: '已执行' + (Array.isArray(r.result) && r.result.length ? '（影响 ' + r.result.length + ' 个实体）' : '') };
          setTimeout(() => this.loadEntities(true), 600);
        } catch (e) { this.svcResult = { ok: false, text: e.message }; }
        finally { this.svcBusy = false; }
      },
      async openDetail(e) {
        this.detail = { e, points: null, histLoading: true };
        try {
          const r = await api('GET', '/ha/entity/' + encodeURIComponent(e.entity_id));
          e.attributes = r.attributes || {};
        } catch { /* 列表里已有的属性够看 */ }
        this.detail.histLoading = true;
        try {
          const r = await api('GET', '/ha/history/' + encodeURIComponent(e.entity_id) + '?hours=24');
          this.detail.points = r.points || [];
        } catch { this.detail.points = []; }
        this.detail.histLoading = false;
      },
      closeDetail() { this.detail = null; },
      attrText(v) {
        if (v == null) return '—';
        if (typeof v === 'object') return JSON.stringify(v).slice(0, 120);
        return String(v).slice(0, 160);
      },
      openSse() {
        this.closeSse();
        try {
          this._es = new EventSource(authed('/api/ha/events'));
          this._es.onmessage = (m) => {
            let p;
            try { p = JSON.parse(m.data); } catch { return; }
            if (p.type === 'state') {
              const e = this.ents.entities.find((x) => x.entity_id === p.entity_id);
              if (e) {
                e.state = p.state;
                e.on = ['on', 'open', 'opening', 'playing'].includes(String(p.state).toLowerCase())
                  || (e.domain === 'climate' && !['off', 'unavailable', 'unknown'].includes(String(p.state).toLowerCase()));
                if (p.attributes && p.attributes.friendly_name) e.name = p.attributes.friendly_name;
              }
              if (this.liveEvents.length > 200) this.liveEvents.pop();
              this.liveEvents.unshift({ ts: Date.parse(p.last_changed) || Date.now(), source: 'state', tag: '状态', k: 's' + Math.random(), text: p.entity_id + ' → ' + p.state });
            } else if (p.type === 'hook' || p.type === 'log') {
              if (this.liveEvents.length > 200) this.liveEvents.pop();
              this.liveEvents.unshift({ ts: p.ts || Date.now(), source: p.type, tag: p.type === 'hook' ? 'HA' : '控制', k: 'h' + Math.random(), text: [p.title, p.message].filter(Boolean).join('：') });
            }
          };
          this._es.onerror = () => { /* EventSource 自带重连 */ };
        } catch { /* 老浏览器无 EventSource：静态列表照常 */ }
      },
      closeSse() { if (this._es) { try { this._es.close(); } catch {} this._es = null; } },
    },
    mounted() {
      this._dragMove = this.dragMove.bind(this);
      this._dragEnd = this.dragEnd.bind(this);
      this.loadAll(false);
      if (this.liveOn) this.openSse();
      this._camTimer = setInterval(() => { if (this.camAuto) this.camTick++; }, 15000);
      this._cfgTimer = setInterval(() => {
        if (document.hidden) return;
        const was = this.wsOn;
        this.loadConfig(false).then(() => { if (!was && this.wsOn) this.autoEntities(true); }).catch(() => {});
      }, 15000);
      this._entTimer = setInterval(() => { if (!document.hidden) this.autoEntities(false); }, 30000);
    },
    beforeUnmount() {
      this.closeSse();
      if (this._camTimer) clearInterval(this._camTimer);
      if (this._cfgTimer) clearInterval(this._cfgTimer);
      if (this._entTimer) clearInterval(this._entTimer);
    },
  };

  // ---------- 任务中心（v1.0.11） ----------
  const Tasks = {
    template: `
    <div>
      <div class="page-head"><h2>任务中心</h2><div class="desc">三类生成队列的进行中 / 排队中任务一览——页面退出后台照样在跑，回来看状态、点停止</div></div>
      <div class="card">
        <div class="row" style="flex:none;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
          <span class="badge" :class="tasks.length ? 'warn' : 'ok'">{{ tasks.length ? tasks.length + ' 个任务' : '当前没有进行中/排队中的任务' }}</span>
          <span class="muted" style="font-size:12px">每 3 秒自动刷新 · 停止排队任务=移出队列；停止执行中任务=先核实 ComfyUI 队列里正是它，再精确中断（不影响共享 GPU 上别人的任务）</span>
          <span style="flex:1"></span>
          <button class="btn sm" :disabled="loading" @click="refresh">{{ loading ? '刷新中…' : '立即刷新' }}</button>
        </div>
        <div v-if="!tasks.length" class="muted" style="padding:16px;text-align:center">暂无进行中任务</div>
        <table v-else>
          <thead><tr><th>类型</th><th>#</th><th>用户</th><th>提示词</th><th>状态</th><th style="width:22%">过程</th><th>排队</th><th>ComfyUI</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="t in tasks" :key="t.kind + ':' + t.id">
              <td><span class="badge dim">{{ t.kind_label }}</span></td>
              <td>{{ t.id }}</td>
              <td>{{ t.username }}</td>
              <td class="ellip" style="max-width:220px" :title="t.prompt">{{ t.prompt || '-' }}</td>
              <td><span class="badge" :class="t.status === 'running' ? 'warn' : 'dim'">{{ t.status === 'running' ? '生成中' : '排队中' }}</span></td>
              <td>
                <div class="progress" style="margin:2px 0"><div :style="{width: (t.progress_pct || 0) + '%'}"></div></div>
                <span class="muted" style="font-size:11px">{{ t.progress_pct || 0 }}% · {{ t.progress || '-' }}</span>
              </td>
              <td class="muted">{{ t.status === 'pending' ? (t.queue_pos >= 0 ? '第 ' + (t.queue_pos + 1) + ' 位' : '-') : '—' }}</td>
              <td class="muted" style="font-size:12px">{{ comfyText(t) }}</td>
              <td style="white-space:nowrap">
                <button class="btn sm danger" :disabled="stopping === t.kind + ':' + t.id" @click="stop(t)">
                  {{ stopping === t.kind + ':' + t.id ? '停止中…' : '停止' }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="stopMsg" class="alert ok" style="margin-top:10px">{{ stopMsg }}</div>
        <div v-if="stopErr" class="alert err" style="margin-top:10px">{{ stopErr }}</div>
      </div>
      <div class="card">
        <h3>说明</h3>
        <div class="muted" style="font-size:13px;line-height:1.8">
          · 生成任务是串行队列（单 GPU），排队中的任务在前一个完成后自动开始。<br />
          · 「停止」排队任务：直接移出队列，标记为失败（不占用 GPU）。<br />
          · 「停止」执行中任务：先查 ComfyUI 队列确认当前执行/排队的正是这个任务，再精确中断或移出——同一 GPU 上其他人的任务不受影响。<br />
          · 服务重启会自动把进行中的任务标记为失败（不会再出现僵尸「生成中」）。
        </div>
      </div>
    </div>`,
    data() { return { tasks: [], loading: false, stopping: '', stopMsg: '', stopErr: '', timer: null }; },
    methods: {
      fmtDur(ms) {
        if (!ms || ms <= 0) return '-';
        if (ms < 60000) return (ms / 1000).toFixed(0) + 's';
        const m = Math.floor(ms / 60000), s = Math.round((ms % 60000) / 1000);
        return m + 'm' + (s ? s + 's' : '');
      },
      comfyText(t) {
        if (!t.comfy) return t.status === 'pending' ? '未提交' : '（未登记）';
        const s = { executing: '执行中', queued: 'ComfyUI 排队', 'history/收尾': '采样完成·收尾', 未知: '状态未知' }[t.comfy.state] || t.comfy.state;
        return s + ' · ' + this.fmtDur(Date.now() - (t.comfy.submitted_at || Date.now())) + '前提交';
      },
      async refresh() {
        this.loading = true;
        try {
          const d = await api('GET', '/tasks');
          this.tasks = d.tasks || [];
        } catch (e) { this.stopErr = e.message; }
        finally { this.loading = false; }
      },
      async stop(t) {
        const k = t.kind + ':' + t.id;
        this.stopping = k; this.stopMsg = ''; this.stopErr = '';
        try {
          const r = await api('POST', '/tasks/' + t.kind + '/' + t.id + '/stop');
          const phase = { pending: '已从队列移除', 'comfy-queued': '已移出 ComfyUI 队列，正在收尾', executing: '已中断执行，正在收尾', 'just-finished': '它刚好自己完成了', 'history/收尾': '正在收尾（取消标志已置）' }[r.phase] || r.phase;
          this.stopMsg = '任务 #' + t.id + '：' + phase + '——状态将在几秒内更新为「失败」';
        } catch (e) { this.stopErr = '停止失败：' + e.message; }
        finally { this.stopping = ''; setTimeout(() => this.refresh(), 1500); }
      },
    },
    mounted() { this.refresh(); this.timer = setInterval(() => { if (!document.hidden) this.refresh(); }, 3000); },
    beforeUnmount() { if (this.timer) clearInterval(this.timer); },
  };

  // ---------- 根组件 ----------
  const App = {
    template: `
    <Login v-if="!store.user"/>
    <div v-else class="layout">
      <aside class="sidebar">
        <div class="logo">
          <div class="logo-row"><span class="material-icons logo-ic">movie_filter</span><h2>衍像</h2></div>
          <div class="sub">EvolveShot</div>
        </div>
        <nav class="nav">
          <button v-if="can('zimage')" class="nav-item" :class="{active: store.route==='zimage'}" @click="store.nav('zimage')"><span class="material-icons">image</span>文生图Z</button>
          <button v-if="can('zimage')" class="nav-item" :class="{active: store.route==='h3image'}" @click="store.nav('h3image')"><span class="material-icons">auto_awesome</span>文生图H3</button>
          <button v-if="can('h3')" class="nav-item" :class="{active: store.route==='h3'}" @click="store.nav('h3')"><span class="material-icons">movie</span>生视频H3</button>
          <button v-if="can('zimage')" class="nav-item" :class="{active: store.route==='ad'}" @click="store.nav('ad')"><span class="material-icons">layers</span>分层图</button>
          <button v-if="can('generate')" class="nav-item" :class="{active: store.route==='generate'}" @click="store.nav('generate')"><span class="material-icons">switch_video</span>首尾视频</button>
          <button v-if="can('edit')" class="nav-item" :class="{active: store.route==='edit'}" @click="store.nav('edit')"><span class="material-icons">content_cut</span>视频剪辑</button>
          <button v-if="can('voice')" class="nav-item" :class="{active: store.route==='voice'}" @click="store.nav('voice')"><span class="material-icons">record_voice_over</span>语音配音</button>
          <button v-if="can('tasks')" class="nav-item" :class="{active: store.route==='tasks'}" @click="store.nav('tasks')"><span class="material-icons">fact_check</span>任务中心</button>
          <button v-if="can('history')" class="nav-item" :class="{active: store.route==='history'}" @click="store.nav('history')"><span class="material-icons">history</span>我的历史</button>
          <button v-if="can('user-history')" class="nav-item" :class="{active: store.route==='user-history'}" @click="store.nav('user-history')"><span class="material-icons">manage_search</span>用户历史</button>
          <button v-if="can('models')" class="nav-item" :class="{active: store.route==='models'}" @click="store.nav('models')"><span class="material-icons">tune</span>模型配置</button>
          <button class="nav-item" :class="{active: store.route==='settings'}" @click="store.nav('settings')"><span class="material-icons">settings</span>设置</button>
          <button v-if="can('ha')" class="nav-item" :class="{active: store.route==='ha'}" @click="store.nav('ha')"><span class="material-icons">power_settings_new</span>远程开机</button>
        </nav>
        <div class="foot">
          <div class="env" style="margin-bottom:10px">
            <span class="badge" :class="comfyBadge.cls" :title="store.comfyStatus.url">{{ comfyBadge.text }}</span>
            <div class="muted" v-if="store.comfyStatus.device" style="margin-top:4px">{{ store.comfyStatus.device }}</div>
          </div>
          <div class="who">{{ store.user.display_name || store.user.username }}（{{ store.user.role==='admin' ? '管理员' : '用户' }}）</div>
          <button class="btn sm" style="width:100%" @click="store.logout()">退出登录</button>
        </div>
      </aside>
      <main class="main">
        <component :is="view" :key="store.route" />
      </main>
      <GpuWidget/>
      <MediaViewer/>
    </div>`,
    data() { return { store }; },
    computed: {
      view() {
        const m = { generate: Generate, zimage: ZImage, h3image: H3Image, ad: ZImageAd, h3: H3, ha: HaPanel, tasks: Tasks, history: MyHistory, 'user-history': UserHistory, models: Models, voice: Voice, edit: Edit, settings: Settings };
        return m[store.route] || Generate;
      },
      comfyBadge() {
        const s = store.comfyStatus || {};
        if (!s.running) return { cls: 'err', text: '模型端离线' };
        if (s.mode === 'remote') return { cls: 'ok', text: '远端模型 · 在线' };
        return { cls: 'ok', text: '本地模型 · 在线' };
      },
    },
    methods: {
      can(page) {
        const u = store.user;
        if (!u) return false;
        if (u.role === 'admin') return true;
        return (u.allowed_pages || []).includes(page);
      },
    },
    mounted() {
      store.refreshComfy();
      this._comfyTimer = setInterval(() => store.refreshComfy(), 15000);
    },
    unmounted() { if (this._comfyTimer) clearInterval(this._comfyTimer); },
  };

  window.addEventListener('hashchange', () => {
    store.route = (location.hash || '#/generate').replace(/^#\/?/, '') || 'generate';
  });

  // v1.0.35 版本守卫：SPA 常驻标签页不会自己重载 app.js——部署新版后旧页面要等用户
  // 手动 F5 才拿到新代码（2026-11-10 报障「广告图默认还是 1920」实为部署前的旧标签页）。
  // 站内导航时对 /api/health 版本（30s 节流；用户取消提醒后 10 分钟内不再打扰）。
  const PAGE_VER = (((document.querySelector('script[src*="app.js?v="]') || {}).src || '').match(/[?&]v=([0-9.]+)/) || [])[1] || '';
  let verCheckedAt = 0, verSnoozeUntil = 0, verPrompted = false;
  async function checkVersion() {
    if (!PAGE_VER || !store.user) return;
    const now = Date.now();
    if (now - verCheckedAt < 30000 || now < verSnoozeUntil) return;
    verCheckedAt = now;
    try {
      const h = await api('GET', '/health');
      if (h.version && h.version !== PAGE_VER) {
        // v1.0.45：每次页面加载最多提醒一次——确认刷新后版本仍不一致说明缓存层有问题，
        // 再弹也解决不了（1.0.44 部署后 index.html 的 ?v= 没跟包走，刷新一次弹一次）。
        if (verPrompted) return;
        verPrompted = true;
        if (confirm('系统已更新到 v' + h.version + '，当前页面还是旧版（v' + PAGE_VER + '）。现在刷新加载新版？')) location.reload();
        else verSnoozeUntil = now + 600000;
      }
    } catch (e) { /* health 暂不可达（升级重启窗口）不打扰 */ }
  }
  window.addEventListener('hashchange', checkVersion);

  const app = createApp(App);
  app.mixin(clockMixin); // 进度耗时计时（v1.0.13，三个生成页用；别的组件带上也无害）
  app.component('Login', Login);
  app.component('Generate', Generate);
  app.component('ZImage', ZImage);
  app.component('H3Image', H3Image);
  app.component('ZImageAd', ZImageAd);
  app.component('H3', H3);
  app.component('HaPanel', HaPanel);
  app.component('Tasks', Tasks);
  app.component('MyHistory', MyHistory);
  app.component('UserHistory', UserHistory);
  app.component('Models', Models);
  app.component('Voice', Voice);
  app.component('Edit', Edit);
  app.component('EditStudio', EditStudio);
  app.component('Settings', Settings);
  app.component('GpuWidget', GpuWidget);
  app.component('PasteDlg', PasteDlg);
  app.component('MediaViewer', MediaViewer);
  document.documentElement.dataset.theme = store.theme; // 启动即应用缓存主题（此前仅切换时生效）
  store.init().finally(() => app.mount('#app'));
})();
