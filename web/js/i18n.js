/* UI strings. The tool ships on a .jp domain but is used by Chinese- and
 * English-speaking customers too, so the language follows the browser and can
 * be switched by hand. */

const STRINGS = {
  ja: {
    'app.title': 'PowerDiag OBI',
    'app.subtitle': 'バッテリー診断ツール',
    'btn.connect': '接続', 'btn.disconnect': '切断',
    'btn.read': 'すべて読み取る', 'btn.cells': 'セル電圧を読み取る', 'btn.refresh': '読み取り',
    'btn.clearErrors': 'エラーを解除', 'btn.ledsOn': 'LED 点灯', 'btn.ledsOff': 'LED 消灯',
    'status.idle': '未接続', 'status.connecting': '接続中…', 'status.connected': '接続済み',
    'status.reading': '読み取り中…', 'status.done': '完了', 'status.cleared': 'エラーを解除しました',
    'field.model': '型番', 'field.state': '状態', 'field.statusCode': 'ステータスコード',
    'field.chargeCount': '充電回数*', 'field.capacity': '容量', 'field.batteryType': 'バッテリー種別',
    'field.manufactured': '製造日', 'field.romId': 'ROM ID', 'field.message': 'バッテリーメッセージ',
    'field.terminalVoltage': '端子電圧（実測）', 'field.packVoltage': 'パック電圧',
    'field.cell': 'セル', 'field.cellDiff': 'セル電圧差',
    'field.tempCell': '温度センサー 1', 'field.tempMosfet': '温度センサー 2',
    'state.locked': 'ロック', 'state.unlocked': '正常',
    'sec.identity': '識別情報', 'sec.voltages': '電圧', 'sec.log': '通信ログ',
    'log.show': 'ログを表示', 'log.hide': 'ログを隠す',
    'log.clear': 'クリア', 'log.export': 'エクスポート',
    'confirm.clear': 'エラー解除を実行します。バッテリーによっては充電回数などの記録が初期化されることがあります。続行しますか？',
    'note.charge': '* 充電回数は参考値であり、メーカー公式の値ではありません。',
    'note.limited': 'この型（F0513）は診断機能が限定されています。',
    'err.unsupported': 'このブラウザは Web Serial に対応していません。パソコンの Chrome または Edge をお使いください。',
    'err.insecure': 'HTTPS でないため Web Serial を利用できません。',
    'err.noPort': 'ポートが選択されませんでした。',
    'err.notConnected': '接続されていません。', 'err.disconnected': '接続が切断されました。',
    'err.timeout': '応答がありません。バッテリーが正しく装着されているか確認してください。',
    'err.allFF': 'バッテリーと通信できません。接点を確認してください。',
    'err.shortResponse': '応答が不完全です。', 'err.noResponse': '応答がありません。',
    'err.mismatch': '応答の形式が一致しません。OBI 基板ではない可能性があります。',
    'err.notObi': 'この端末は応答しません。OBI 基板ではない可能性があります。別のポートを選んでください。',
    'err.portBusy': 'ポートが他で使用中です。このツールを開いている他のタブや、シリアルモニターを閉じてください。',
    'err.driver': 'ポート一覧に基板が出ない場合は USB シリアルドライバー（CH340 など）が必要です。',
  },
  en: {
    'app.title': 'PowerDiag OBI',
    'app.subtitle': 'Battery pack diagnostics',
    'btn.connect': 'Connect', 'btn.disconnect': 'Disconnect',
    'btn.read': 'Read everything', 'btn.cells': 'Read cell voltages', 'btn.refresh': 'Read',
    'btn.clearErrors': 'Clear errors', 'btn.ledsOn': 'LEDs on', 'btn.ledsOff': 'LEDs off',
    'status.idle': 'Not connected', 'status.connecting': 'Connecting…', 'status.connected': 'Connected',
    'status.reading': 'Reading…', 'status.done': 'Done', 'status.cleared': 'Errors cleared',
    'field.model': 'Model', 'field.state': 'State', 'field.statusCode': 'Status code',
    'field.chargeCount': 'Charge count*', 'field.capacity': 'Capacity', 'field.batteryType': 'Battery type',
    'field.manufactured': 'Manufactured', 'field.romId': 'ROM ID', 'field.message': 'Battery message',
    'field.terminalVoltage': 'Terminal voltage (measured)', 'field.packVoltage': 'Pack voltage',
    'field.cell': 'Cell', 'field.cellDiff': 'Cell voltage difference',
    'field.tempCell': 'Temperature sensor 1', 'field.tempMosfet': 'Temperature sensor 2',
    'state.locked': 'LOCKED', 'state.unlocked': 'UNLOCKED',
    'sec.identity': 'Identity', 'sec.voltages': 'Voltages', 'sec.log': 'Communication log',
    'log.show': 'Show log', 'log.hide': 'Hide log',
    'log.clear': 'Clear', 'log.export': 'Export',
    'confirm.clear': 'This clears the error flags on the pack. On some batteries it also resets stored counters such as the charge count. Continue?',
    'note.charge': '* Charge count is a best-effort reading, not an official manufacturer figure.',
    'note.limited': 'This pack (F0513) only supports limited diagnostics.',
    'err.unsupported': 'This browser does not support Web Serial. Use desktop Chrome or Edge.',
    'err.insecure': 'Web Serial needs HTTPS.',
    'err.noPort': 'No port was selected.',
    'err.notConnected': 'Not connected.', 'err.disconnected': 'The board was disconnected.',
    'err.timeout': 'No response. Check that the battery is seated properly.',
    'err.allFF': 'Cannot talk to the battery. Check the contacts.',
    'err.shortResponse': 'Incomplete response.', 'err.noResponse': 'No response.',
    'err.mismatch': 'The reply does not match the request — probably not an OBI board.',
    'err.notObi': 'That device did not answer. It is probably not an OBI board — pick a different port.',
    'err.portBusy': 'The port is in use. Close any other tab running this tool, or a serial monitor holding it.',
    'err.driver': 'If the board is missing from the port list, install the USB-serial driver (CH340 or similar).',
  },
  zh: {
    'app.title': 'PowerDiag OBI',
    'app.subtitle': '电池诊断工具',
    'btn.connect': '连接', 'btn.disconnect': '断开',
    'btn.read': '读取全部', 'btn.cells': '读取电芯电压', 'btn.refresh': '读取',
    'btn.clearErrors': '清除错误', 'btn.ledsOn': '点亮 LED', 'btn.ledsOff': '熄灭 LED',
    'status.idle': '未连接', 'status.connecting': '连接中…', 'status.connected': '已连接',
    'status.reading': '读取中…', 'status.done': '完成', 'status.cleared': '错误已清除',
    'field.model': '型号', 'field.state': '状态', 'field.statusCode': '状态码',
    'field.chargeCount': '充电次数*', 'field.capacity': '容量', 'field.batteryType': '电池类型',
    'field.manufactured': '生产日期', 'field.romId': 'ROM ID', 'field.message': '电池报文',
    'field.terminalVoltage': '端子电压（实测）', 'field.packVoltage': '整包电压',
    'field.cell': '电芯', 'field.cellDiff': '电芯压差',
    'field.tempCell': '温度传感器 1', 'field.tempMosfet': '温度传感器 2',
    'state.locked': '锁定', 'state.unlocked': '正常',
    'sec.identity': '识别信息', 'sec.voltages': '电压', 'sec.log': '通信日志',
    'log.show': '显示日志', 'log.hide': '隐藏日志',
    'log.clear': '清空', 'log.export': '导出',
    'confirm.clear': '将清除电池的错误标志。部分电池会同时把充电次数等记录清零。是否继续？',
    'note.charge': '* 充电次数为读取推算值，非厂商官方口径。',
    'note.limited': '该型号（F0513）仅支持有限的诊断功能。',
    'err.unsupported': '当前浏览器不支持 Web Serial，请使用电脑版 Chrome 或 Edge。',
    'err.insecure': 'Web Serial 需要 HTTPS 才能使用。',
    'err.noPort': '未选择串口。',
    'err.notConnected': '尚未连接。', 'err.disconnected': '设备已断开。',
    'err.timeout': '没有响应，请确认电池是否插到位。',
    'err.allFF': '无法与电池通信，请检查触点。',
    'err.shortResponse': '响应不完整。', 'err.noResponse': '没有响应。',
    'err.mismatch': '响应格式不匹配，可能不是 OBI 板。',
    'err.notObi': '该设备没有响应，可能不是 OBI 板。请换一个端口。',
    'err.portBusy': '端口被占用。请关闭开着本工具的其他标签页，或占用串口的串口监视器。',
    'err.driver': '端口列表里找不到本板时，需要安装 USB 串口驱动（CH340 等）。',
  },
};

const STORAGE_KEY = 'powerdiag-obi-lang';

function detect() {
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved && STRINGS[saved]) return saved;
  const tag = (navigator.language || 'en').toLowerCase();
  if (tag.startsWith('ja')) return 'ja';
  if (tag.startsWith('zh')) return 'zh';
  return 'en';
}

export const i18n = {
  lang: detect(),
  languages: Object.keys(STRINGS),
  t(key) {
    return STRINGS[this.lang][key] ?? STRINGS.en[key] ?? key;
  },
  set(lang) {
    if (!STRINGS[lang]) return;
    this.lang = lang;
    localStorage.setItem(STORAGE_KEY, lang);
    document.documentElement.lang = lang;
  },
};
