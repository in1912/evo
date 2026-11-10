// Home Assistant 实体域分类（v1.0.11，衍像「HomeAssistant」页；自工作台 v1.14.0 移植）。
// 纯函数、零依赖：域 → 中文标签 / 可控判定 / 开关服务映射 / 开态判定 / 状态话术。
//
// 域分两档（衍像无语音链路，voiceItemsFrom 未随迁）：
//   VOICE_DOMAINS  有明确「打开/关闭」语义的常规可控域；
//   PANEL_DOMAINS  语义敏感或动作型（门锁/场景/脚本/自动化/吸尘器），面板上可以点；
//   其余           只读展示（sensor/binary_sensor/weather/person/…），无开关能力。

const VOICE_DOMAINS = ['light', 'switch', 'fan', 'climate', 'cover', 'humidifier', 'water_heater', 'media_player', 'input_boolean'];
const PANEL_DOMAINS = ['lock', 'scene', 'script', 'automation', 'vacuum', 'siren', 'button'];

const DOMAIN_LABELS = {
  light: '灯', switch: '开关', fan: '风扇', climate: '温控', cover: '窗帘/卷帘',
  humidifier: '加湿器', water_heater: '热水器', media_player: '媒体播放', input_boolean: '虚拟开关',
  sensor: '传感器', binary_sensor: '二元传感器', weather: '天气', sun: '日照', zone: '区域',
  person: '成员', device_tracker: '设备追踪', camera: '摄像头', lock: '门锁', scene: '场景',
  script: '脚本', automation: '自动化', vacuum: '吸尘器', siren: '警笛', button: '按钮',
  alarm_control_panel: '安防', input_number: '虚拟数值', input_select: '虚拟选择', input_text: '虚拟文本',
  number: '数值', select: '选择', text: '文本', time: '时间', datetime: '日期时间', date: '日期',
  timer: '计时器', todo: '待办', calendar: '日历', update: '更新', sun2: '日照', image: '图片',
};

// 域 → 开关服务映射。盖帘没有 turn_on：开=open_cover、关=close_cover、切=stop_cover（HA 语义）。
function serviceFor(domain, action) {
  if (domain === 'cover') {
    if (action === 'on') return 'open_cover';
    if (action === 'off') return 'close_cover';
    return 'stop_cover';
  }
  if (action === 'toggle') return 'toggle';
  if (action === 'on') return 'turn_on';
  if (action === 'off') return 'turn_off';
  return null;
}

// 实体当前是否处于「开」态。HA state 各域口径不同：
//   常规域 'on'；盖帘 'open'/'opening'；媒体 'playing'（paused 算关）；温控非 off 即开
//   （idle=已开机在待温，不是关机）；unavailable/unknown 一律算关（不可控）。
function isOn(domain, state, attributes) {
  const s = String(state == null ? '' : state).toLowerCase();
  if (!s || s === 'unavailable' || s === 'unknown' || s === 'off' || s === 'closed' || s === 'none') return false;
  if (domain === 'cover') return s === 'open' || s === 'opening';
  if (domain === 'media_player') return s === 'playing' || s === 'on';
  if (domain === 'climate') return true;
  return s === 'on';
}

// 面板一行用的状态短话术（数字传感器带单位；二元/常规域给中文）。
function stateText(domain, state, attributes) {
  const s = String(state == null ? '' : state);
  if (s === 'unavailable') return '不可用';
  if (s === 'unknown') return '未知';
  const attrs = attributes || {};
  if (attrs.unit_of_measurement) {
    const num = Number(s);
    return (Number.isFinite(num) ? num : s) + ' ' + String(attrs.unit_of_measurement);
  }
  if (domain === 'binary_sensor') return s === 'on' ? (attrs.device_class === 'motion' ? '有动静' : '开') : (attrs.device_class === 'motion' ? '无动静' : '关');
  if (domain === 'climate') {
    const cur = Number(attrs.current_temperature);
    const t = Number.isFinite(cur) ? `，${cur}°C` : '';
    const act = String(attrs.hvac_action || '');
    const actText = act === 'heating' ? '制热中' : act === 'cooling' ? '制冷中' : act === 'idle' ? '待温' : s;
    return actText + t;
  }
  if (isOn(domain, s, attrs)) return '开着';
  return '关着';
}

function labelOf(domain) { return DOMAIN_LABELS[domain] || domain; }
function isVoiceDomain(domain) { return VOICE_DOMAINS.includes(domain); }
function isControllable(domain) { return VOICE_DOMAINS.includes(domain) || PANEL_DOMAINS.includes(domain); }

// 分类图标 = Material Icons 单色字形白名单（与前端勾选界面逐项一致）。
const CATEGORY_ICONS = [
  'home', 'lightbulb', 'curtains', 'photo_camera', 'air', 'device_thermostat',
  'tv', 'speaker', 'lock', 'sensors', 'water_drop', 'hot_tub', 'power_settings_new',
  'cleaning_services', 'security', 'kitchen', 'garage', 'yard', 'directions_car', 'pets',
];
function isCategoryIcon(s) { return CATEGORY_ICONS.includes(String(s || '')); }

// 仪表盘条目键：dev:<device_id> 或 ent:<entity_id>
function isDashKey(s) {
  return typeof s === 'string' && /^(dev|ent):[\w.-]{1,64}$/.test(s);
}

module.exports = {
  VOICE_DOMAINS, PANEL_DOMAINS, serviceFor, isOn, stateText, labelOf, isVoiceDomain, isControllable,
  CATEGORY_ICONS, isCategoryIcon, isDashKey,
};
