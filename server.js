/**
 * 단지 DB 중계 프록시 서버
 * - 공공데이터포털 서비스키를 서버에만 보관(클라이언트 노출 X)
 * - 브라우저(견적 엔진)의 CORS 제약을 우회해 대신 API 호출
 * - 이름 일부(중간·끝 단어, 공백 무관)만으로 전국 검색
 * 실행:  SERVICE_KEY=발급키 node server.js   /   모의:  MOCK=1 node server.js
 */
const express = require('express');
const cors = require('cors');
const { XMLParser } = require('fast-xml-parser');

const fs = require('fs');
const path = require('path');
const app = express();
app.set('trust proxy', 1);                       // Render 등 프록시 뒤 실제 IP 인식
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '';   // 비우면 전체 허용(개발), 운영 시 자기 도메인만
app.use(cors(ALLOW_ORIGIN ? { origin: ALLOW_ORIGIN.split(',').map(s=>s.trim()) } : {}));
app.use(express.json({ limit: '100kb' }));       // 과대 페이로드 차단
app.use(express.static(__dirname, { dotfiles: 'deny' }));  // 견적앱 HTML 서빙 (.env 등 dotfile 노출 차단)
// 간단 레이트리밋 (IP·경로별, 메모리)
const _rl = new Map();
function rateLimit(name, max, windowMs){
  return (req, res, next) => {
    const key = (req.ip || 'x') + '|' + name;
    const now = Date.now(); let e = _rl.get(key);
    if (!e || now > e.reset) { e = { c:0, reset: now + windowMs }; _rl.set(key, e); }
    e.c++;
    if (_rl.size > 5000) { for (const [k,v] of _rl) if (now > v.reset) _rl.delete(k); }  // 주기적 정리
    if (e.c > max) return res.status(429).json({ error: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.' });
    next();
  };
}
app.use('/api/', rateLimit('api', 150, 60000));     // 일반 API: IP당 150회/분
app.use('/api/lead', rateLimit('lead', 15, 60000)); // 리드 제출: IP당 15회/분

const PORT = process.env.PORT || 4000;
const KEY  = process.env.SERVICE_KEY || '';
const MOCK = process.env.MOCK === '1';

// 소셜 로그인 설정 (개발자센터에서 발급 후 환경변수로)
const BASE_URL = (process.env.BASE_URL || ('http://localhost:' + PORT)).replace(/\/+$/,'');
const KAKAO_ID = process.env.KAKAO_CLIENT_ID || '';
const KAKAO_SECRET = process.env.KAKAO_CLIENT_SECRET || '';
const NAVER_ID = process.env.NAVER_CLIENT_ID || '';
const NAVER_SECRET = process.env.NAVER_CLIENT_SECRET || '';
// 관리자 비밀번호 (운영 시 반드시 환경변수로 변경)
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme1234';
function requireAdmin(req, res, next){
  const pass = req.headers['x-admin-pass'] || req.query.pass || '';
  if (pass === ADMIN_PASS) return next();
  res.set('WWW-Authenticate','Admin').status(401).json({ error: '관리자 인증 필요' });
}

// 개인정보·로그 보관기간 (일) — 경과분 자동 파기
const RETENTION_LEADS = Number(process.env.RETENTION_LEADS || 365);  // 고객 개인정보 1년
const RETENTION_LOGS  = Number(process.env.RETENTION_LOGS  || 180);  // 접속·세션 로그 6개월
function purgeFile(p, days){
  let arr; try{ arr = JSON.parse(require('fs').readFileSync(p,'utf8')); }catch(e){ return 0; }
  if(!Array.isArray(arr)) return 0;
  const cutoff = Date.now() - days*86400000;
  const kept = arr.filter(r => { const ts = Date.parse(r && r.ts); return isNaN(ts) ? true : ts >= cutoff; });
  if(kept.length !== arr.length){ try{ require('fs').writeFileSync(p, JSON.stringify(kept,null,2)); }catch(e){} }
  return arr.length - kept.length;
}
function purgeAll(){
  const path = require('path');
  const a = purgeFile(path.join(__dirname,'leads.json'),    RETENTION_LEADS);
  const b = purgeFile(path.join(__dirname,'visits.json'),   RETENTION_LOGS);
  const c = purgeFile(path.join(__dirname,'sessions.json'), RETENTION_LOGS);
  if(a||b||c) console.log('[파기] leads '+a+', visits '+b+', sessions '+c);
  return { leads:a, visits:b, sessions:c };
}

// 새 리드 알림 + 무료 영속 백업 (모두 선택 — env 설정 시에만 동작)
/* ---------- 텔레그램 알림 (그룹 chat_id 자동탐지) ---------- */
const TG_CACHE = path.join(__dirname, 'tg_chat.json');
const TG_GROUP_HINT = process.env.TELEGRAM_GROUP || '매트 견적 고객';
function tgToken(){ return process.env.TELEGRAM_BOT_TOKEN || ''; }
function tgChatId(){
  if (process.env.TELEGRAM_CHAT_ID) return process.env.TELEGRAM_CHAT_ID;
  try { return JSON.parse(fs.readFileSync(TG_CACHE,'utf8')).chatId || ''; } catch(e){ return ''; }
}
async function tgSendTo(chatId, text){
  if (!tgToken() || !chatId) return { ok:false, reason:'no-token-or-chat' };
  try {
    const r = await fetch('https://api.telegram.org/bot'+tgToken()+'/sendMessage',
      { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ chat_id: chatId, text }) });
    return await r.json();
  } catch(e){ return { ok:false, reason:e.message }; }
}
async function tgDetect(){
  if (!tgToken()) return { ok:false, reason:'no-token' };
  let j;
  try { j = await (await fetch('https://api.telegram.org/bot'+tgToken()+'/getUpdates?limit=100')).json(); }
  catch(e){ return { ok:false, reason:e.message }; }
  const chats = {};
  (j.result || []).forEach(function(u){
    const m = u.message || u.my_chat_member || u.channel_post || u.edited_message || {};
    const c = m.chat;
    if (c && (c.type==='group' || c.type==='supergroup')) chats[c.id] = { id:c.id, title:c.title||'', type:c.type };
  });
  const list = Object.values(chats);
  let pick = list.find(function(c){ return (c.title||'').includes(TG_GROUP_HINT); }) || list[0] || null;
  if (pick) { try { fs.writeFileSync(TG_CACHE, JSON.stringify({ chatId:String(pick.id), title:pick.title, updated:Date.now() }, null, 2)); } catch(e){} }
  return { ok: !!pick, pick, list };
}
function tgNotify(text){
  if (!tgToken()) return;
  const id = tgChatId();
  if (id) { tgSendTo(id, text); return; }
  tgDetect().then(function(d){ if (d.ok) tgSendTo(String(d.pick.id), text); }).catch(function(){});
}
function notifyLead(rec){
  const c = rec.cust || {};
  const won = n => (n!=null ? Number(n).toLocaleString('ko-KR') : '');
  const danji = (rec.danji && (rec.danji.kaptName || rec.danji)) || '';
  const text = '🧩 새 견적/상담 신청\n'
    + '이름: ' + (c.name||'') + '\n연락처: ' + (c.phone||'') + '\n'
    + (c.addr ? '주소: ' + c.addr + '\n' : '')
    + '단지: ' + danji + '\n매트: ' + (rec.company||'') + '\n'
    + '합계(예상): ' + won(rec.total) + '원\n희망시간: ' + (c.time||'') + '\n시간: ' + rec.ts;
  // ① 텔레그램 (무료, 그룹 자동탐지)
  tgNotify(text);
  // ② 범용 웹훅 (슬랙/디스코드/카톡 솔루션 등 — 대부분 무료)
  if (process.env.NOTIFY_WEBHOOK) {
    fetch(process.env.NOTIFY_WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ text, lead: rec }) }).catch(()=>{});
  }
  // ③ 구글시트 백업 (Apps Script 웹앱 — 무료 영속 보관)
  if (process.env.SHEETS_WEBHOOK) {
    fetch(process.env.SHEETS_WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(rec) }).catch(()=>{});
  }
}

const BASE_LIST = 'https://apis.data.go.kr/1613000/AptListService3';
const BASE_INFO = 'https://apis.data.go.kr/1613000/AptBasisInfoServiceV4';

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: true });
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60;

async function callApi(url) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.data;
  const res = await fetch(url);
  const text = await res.text();
  // 공공데이터 게이트웨이가 HTTP 오류(500/403 등)로 응답한 경우
  if (!res.ok) {
    const snip = String(text).replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error('공공데이터 응답 ' + res.status + ' — ' + (snip || '(본문 없음)') + ' · 인증키 활용신청/승인·Encoding키 여부를 확인하세요');
  }
  let data;
  const t = String(text).trim();
  try { data = (t[0] === '{' || t[0] === '[') ? JSON.parse(t) : parser.parse(t); }
  catch (e) { throw new Error('응답 파싱 실패: ' + e.message); }
  // 정상 XML(response 구조)이 아니면(예: "Unexpected errors" 평문) → 인증/주소 문제
  if (!data || !data.response) {
    const snip = String(text).replace(/\s+/g, ' ').trim().slice(0, 120);
    throw new Error('공공데이터 비정상 응답 — ' + (snip || '(빈 응답)') + ' · 인증키(활용신청/승인) 확인 필요');
  }
  const header = data.response.header;
  if (header && String(header.resultCode) !== '00' && String(header.resultCode) !== '0') {
    throw new Error('API 오류 ' + header.resultCode + ': ' + header.resultMsg);
  }
  cache.set(url, { t: Date.now(), data });
  return data;
}
function asArray(x) { return Array.isArray(x) ? x : (x == null ? [] : [x]); }
// 공공데이터 응답에서 목록 아이템 추출 (XML: items.item / JSON: items 배열·단일 모두 대응)
function extractItems(body) {
  if (!body) return [];
  const its = body.items;
  if (its == null) return [];
  if (Array.isArray(its)) return its;
  if (its.item !== undefined) return asArray(its.item);
  return asArray(its);
}
function extractItem(body) {
  if (!body) return null;
  if (body.item !== undefined) { const x = body.item; return Array.isArray(x) ? x[0] : x; }
  const arr = extractItems(body);
  return arr.length ? arr[0] : null;
}

// 공백·대소문자 무시 정규화
function norm(s) { return String(s || '').replace(/\s+/g, '').toLowerCase(); }
// 토큰 매칭: 입력을 공백으로 쪼갠 모든 조각이 이름 어디든(중간·끝 포함) 들어가면 매치
function matchName(name, keyword) {
  const nn = norm(name);
  const tokens = String(keyword || '').trim().split(/\s+/).map(norm).filter(Boolean);
  if (!tokens.length) return true;
  return tokens.every(t => nn.includes(t));
}

function normalizeListItem(it) {
  return { kaptCode: it.kaptCode, kaptName: it.kaptName, bjdCode: it.bjdCode || it.bjdongCode || null, sido: it.as1 || '', sigungu: it.as2 || '' };
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function normalizeDetail(it) {
  return {
    kaptCode: it.kaptCode, kaptName: it.kaptName,
    addr: it.kaptAddr || it.doroJuso || '', doroJuso: it.doroJuso || '',
    dongCnt: it.kaptDongCnt != null ? it.kaptDongCnt : null,
    daCnt: it.kaptdaCnt != null ? it.kaptdaCnt : null,
    hallType: it.codeHallNm || '', heat: it.codeHeatNm || '',
    saleType: it.codeSaleNm || '', useDate: it.kaptUsedate || '', bjdCode: it.bjdCode || null,
    areaUnits: { '60이하': num(it.kaptMparea60 != null ? it.kaptMparea60 : it.kaptMparea_60), '60~85': num(it.kaptMparea85 != null ? it.kaptMparea85 : it.kaptMparea_85), '85~135': num(it.kaptMparea135 != null ? it.kaptMparea135 : it.kaptMparea_135), '135초과': num(it.kaptMparea136 != null ? it.kaptMparea136 : it.kaptMparea_136) },
  };
}

const MOCK_LIST = [
  { kaptCode:'A10027875', kaptName:'괴정 경성스마트W아파트', bjdCode:'2638010100', sido:'부산', sigungu:'사하구' },
  { kaptCode:'A13800001', kaptName:'마포 래미안 푸르지오', bjdCode:'1111010100', sido:'서울', sigungu:'마포구' },
  { kaptCode:'A13800002', kaptName:'신반포 센트럴자이', bjdCode:'1165010100', sido:'서울', sigungu:'서초구' },
  { kaptCode:'A13800003', kaptName:'송파 헬리오시티', bjdCode:'1171010100', sido:'서울', sigungu:'송파구' },
  { kaptCode:'A13800004', kaptName:'개포 디에이치 아너힐즈', bjdCode:'1168010300', sido:'서울', sigungu:'강남구' },
  { kaptCode:'A13800005', kaptName:'반포 자이', bjdCode:'1165010100', sido:'서울', sigungu:'서초구' },
];
const MOCK_DETAIL = {
  A10027875:{kaptCode:'A10027875',kaptName:'괴정 경성스마트W아파트',kaptAddr:'부산 사하구 괴정동 258',doroJuso:'부산 사하구 낙동대로 180',kaptDongCnt:3,kaptdaCnt:182,codeHallNm:'혼합식',codeHeatNm:'지역난방',codeSaleNm:'분양',kaptUsedate:'20150806',bjdCode:'2638010100',kaptMparea_60:0,kaptMparea_85:182,kaptMparea_135:0,kaptMparea_136:0},
  A13800001:{kaptCode:'A13800001',kaptName:'마포 래미안 푸르지오',kaptAddr:'서울 마포구 ○○동 1',doroJuso:'서울 마포구 ○○로 10',kaptDongCnt:8,kaptdaCnt:740,codeHallNm:'계단식',codeHeatNm:'지역난방',codeSaleNm:'분양',kaptUsedate:'20180301',bjdCode:'1111010100',kaptMparea_60:120,kaptMparea_85:480,kaptMparea_135:140,kaptMparea_136:0},
  A13800002:{kaptCode:'A13800002',kaptName:'신반포 센트럴자이',kaptAddr:'서울 서초구 잠원동 1',doroJuso:'서울 서초구 신반포로 1',kaptDongCnt:21,kaptdaCnt:757,codeHallNm:'계단식',codeHeatNm:'지역난방',codeSaleNm:'분양',kaptUsedate:'20180601',bjdCode:'1165010100',kaptMparea_60:200,kaptMparea_85:400,kaptMparea_135:157,kaptMparea_136:0},
};

let allIndex = null;
let indexLoading = null;
async function getAllDanji() {
  if (MOCK) return MOCK_LIST;
  if (allIndex) return allIndex;
  if (indexLoading) return indexLoading;
  indexLoading = (async () => {
    if (!KEY) throw new Error('SERVICE_KEY 미설정');
    const out = [];
    const rows = 9999;
    let page = 1, total = Infinity;
    while ((page - 1) * rows < total && page <= 200) {
      const url = BASE_LIST + '/getTotalAptList3?pageNo=' + page + '&numOfRows=' + rows + '&_type=json&ServiceKey=' + KEY;
      const data = await callApi(url);
      const body = (data && data.response && data.response.body) || {};
      total = Number(body.totalCount) || out.length;
      const items = extractItems(body);
      if (!items.length) break;
      for (const it of items) out.push(normalizeListItem(it));
      page++;
    }
    allIndex = out; indexLoading = null; return out;
  })();
  return indexLoading;
}

app.get('/api/health', (_req, res) => res.json({ ok: true, mock: MOCK, hasKey: !!KEY, indexed: allIndex ? allIndex.length : 0 }));

app.get('/api/danji/search', async (req, res) => {
  try {
    const sigunguCode = req.query.sigunguCode, bjdCode = req.query.bjdCode;
    const kw = String(req.query.keyword || '').trim();
    const limit = Number(req.query.limit) || 300;
    let items;
    if (sigunguCode || bjdCode) {
      if (MOCK) { items = MOCK_LIST; }
      else {
        if (!KEY) return res.status(400).json({ error: 'SERVICE_KEY 미설정' });
        const url = bjdCode
          ? BASE_LIST + '/getLegaldongAptList3?bjdCode=' + bjdCode + '&pageNo=1&numOfRows=9999&_type=json&ServiceKey=' + KEY
          : BASE_LIST + '/getSigunguAptList3?sigunguCode=' + sigunguCode + '&pageNo=1&numOfRows=9999&_type=json&ServiceKey=' + KEY;
        const data = await callApi(url);
        items = extractItems(data && data.response && data.response.body).map(normalizeListItem);
      }
    } else {
      if (!kw) return res.status(400).json({ error: '검색어(keyword) 또는 지역코드가 필요합니다' });
      items = await getAllDanji();
    }
    const matched = kw ? items.filter(x => matchName(x.kaptName, kw)) : items;
    res.json({ count: matched.length, items: matched.slice(0, limit) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('/api/danji/detail', async (req, res) => {
  try {
    const kaptCode = req.query.kaptCode;
    if (!kaptCode) return res.status(400).json({ error: 'kaptCode 필요' });
    let item;
    if (MOCK) {
      item = MOCK_DETAIL[kaptCode];
      if (!item) return res.status(404).json({ error: '모의 상세 샘플 미등록(검색은 됨)' });
    } else {
      if (!KEY) return res.status(400).json({ error: 'SERVICE_KEY 미설정' });
      const url = BASE_INFO + '/getAphusBassInfoV4?kaptCode=' + kaptCode + '&_type=json&ServiceKey=' + KEY;
      const data = await callApi(url);
      item = extractItem(data && data.response && data.response.body);
      if (!item) return res.status(404).json({ error: '단지 없음' });
    }
    res.json(normalizeDetail(item));
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- 단지+평형 정밀 템플릿 캐시 (#3) ---------- */
const DTPL = path.join(__dirname, 'danji_templates.json');
function readDtpl(){ try{ return JSON.parse(fs.readFileSync(DTPL,'utf8')); }catch(e){ return {}; } }
function writeDtpl(o){ try{ fs.writeFileSync(DTPL, JSON.stringify(o,null,2)); }catch(e){} }
app.get('/api/danji/template', (req, res) => {
  const k = String(req.query.kaptCode||'') + '|' + String(req.query.key||'');
  const all = readDtpl(); res.json(all[k] || null);
});
app.post('/api/danji/template', (req, res) => {
  const b = req.body || {}; const kc = String(b.kaptCode||''), key = String(b.key||'');
  if (!kc || !key) return res.status(400).json({ error: 'kaptCode/key \uD544\uC694' });
  const all = readDtpl();
  all[kc+'|'+key] = { dim: b.dim||{}, livingW: Number(b.livingW)||0, updated: Date.now() };
  writeDtpl(all); res.json({ ok: true });
});

/* ---------- 시공 실적 학습 데이터 ---------- */
const JOBS = path.join(__dirname, 'jobs.json');
function readJobs(){ try{ return JSON.parse(fs.readFileSync(JOBS,'utf8')); }catch(e){ return []; } }
function writeJobs(a){ try{ fs.writeFileSync(JOBS, JSON.stringify(a,null,2)); }catch(e){} }
app.get('/api/jobs', (_req,res)=> res.json({ jobs: readJobs().map(j=>{ const o=Object.assign({},j); const hp=!!o.photo; delete o.photo; o.hasPhoto=hp; return o; }) }));
app.get('/api/jobs/photo', (req,res)=>{ const j=readJobs().find(x=>x.id===String(req.query.id||'')); res.json({ photo: (j&&j.photo)||'' }); });
app.post('/api/jobs', express.json({ limit: '6mb' }), (req,res)=>{
  const b=req.body||{};
  const rec={ id:'J'+Date.now()+Math.floor(Math.random()*1000), date:Date.now(),
    danji:String(b.danji||'').slice(0,80), kaptCode:String(b.kaptCode||'').slice(0,20),
    dong:String(b.dong||'').slice(0,40), pyeong:String(b.pyeong||'').slice(0,20),
    scope:String(b.scope||'').slice(0,30), matSize:Number(b.matSize)||0,
    qty:Number(b.qty)||0, area:Number(b.area)||0, livingW:Number(b.livingW)||0,
    comp:(b.comp&&typeof b.comp==='object')?b.comp:{},
    photo:String(b.photo||''),
    memo:String(b.memo||'').slice(0,200) };
  const all=readJobs(); all.push(rec); writeJobs(all); res.json({ ok:true, id:rec.id });
});
app.post('/api/jobs/delete', (req,res)=>{
  const id=String((req.body||{}).id||''); writeJobs(readJobs().filter(j=>j.id!==id)); res.json({ ok:true });
});

/* ---------- 깔끔한 단축 링크(테스트용) ---------- */
app.get('/jobs',  (_q,res)=> res.sendFile(path.join(__dirname, '\uC2DC\uACF5\uC2E4\uC801_\uD559\uC2B5_v1.html')));
app.get('/record',(_q,res)=> res.sendFile(path.join(__dirname, '\uC2DC\uACF5\uC2E4\uC801_\uD559\uC2B5_v1.html')));
app.get('/pro',   (_q,res)=> res.sendFile(path.join(__dirname, '\uC815\uBC00\uC2E4\uCE21_\uB3C4\uBA74_v1.html')));
app.get('/survey',(_q,res)=> res.sendFile(path.join(__dirname, '\uC815\uBC00\uC2E4\uCE21_\uB3C4\uBA74_v1.html')));

/* ---------- 고객정보(lead) 저장·관리 ---------- */
const LEADS = path.join(__dirname, 'leads.json');
function readLeads(){ try{ return JSON.parse(fs.readFileSync(LEADS,'utf8')); }catch(e){ return []; } }
function writeLeads(a){ fs.writeFileSync(LEADS, JSON.stringify(a,null,2)); }
// 고객 견적/상담 정보 저장 (필수 동의 전제 — 클라이언트에서 동의 후 전송)
app.post('/api/lead', (req,res) => {
  const b = req.body || {};
  const phone = b.phone || (b.cust && b.cust.phone);
  if (!phone) return res.status(400).json({ error: '연락처가 필요합니다' });
  if (!b.agreeReq) return res.status(400).json({ error: '개인정보 수집·이용 동의(필수)가 필요합니다' });
  // 입력 정제·길이 제한
  const cap = (s,n) => String(s==null?'':s).slice(0,n);
  if (b.cust) b.cust = { name:cap(b.cust.name,40), phone:cap(b.cust.phone,20), addr:cap(b.cust.addr,120), time:cap(b.cust.time,20), memo:cap(b.cust.memo,300) };
  const leads = readLeads();
  const rec = Object.assign({ id: Date.now(), ts: new Date().toISOString() }, b);
  leads.push(rec);
  try { writeLeads(leads); } catch(e){ return res.status(500).json({ error: '저장 실패: ' + e.message }); }
  try { notifyLead(rec); } catch(e){}
  res.json({ ok: true, id: rec.id });
});
// 저장된 고객정보 조회 (관리자 — 운영 시 인증 필요)
app.get('/api/leads', requireAdmin, (_req,res) => { const l = readLeads(); res.json({ count: l.length, leads: l }); });

/* ---------- 고객 리뷰(후기) 작성·조회 (#1) ---------- */
const REVIEWS = path.join(__dirname, 'reviews.json');
function readReviews(){ try{ return JSON.parse(fs.readFileSync(REVIEWS,'utf8')); }catch(e){ return []; } }
function writeReviews(a){ try{ fs.writeFileSync(REVIEWS, JSON.stringify(a,null,2)); }catch(e){} }
app.use('/api/reviews', rateLimit('reviews', 20, 60000)); // 후기 도배 방지: IP당 20회/분
// 공개용 후기 목록(승인된 것만, 개인정보 제외)
app.get('/api/reviews', (_req,res) => {
  const list = readReviews().filter(r => r.approved !== false)
    .sort((a,b)=> (b.ts||'').localeCompare(a.ts||''))
    .map(r => ({ id:r.id, nick:r.nick, rating:r.rating, text:r.text, danji:r.danji||'', date:(r.ts||'').slice(0,10) }));
  res.json({ count: list.length, reviews: list });
});
// 후기 작성
app.post('/api/reviews', (req,res) => {
  const b = req.body || {};
  const cap = (s,n) => String(s==null?'':s).replace(/[<>]/g,'').slice(0,n).trim();
  const rr = Number(b.rating);
  if (!(rr >= 1 && rr <= 5)) return res.status(400).json({ error: '별점을 선택해 주세요' });
  const rating = Math.round(rr);
  const text = cap(b.text, 500);
  if (text.length < 2) return res.status(400).json({ error: '후기 내용을 2자 이상 적어주세요' });
  const rec = { id:'R'+Date.now()+Math.floor(Math.random()*1000), ts:new Date().toISOString(),
    nick: cap(b.nick,20) || '익명', rating, text, danji: cap(b.danji,60),
    approved: (process.env.REVIEW_AUTO_APPROVE === '0') ? false : true }; // 기본 자동 노출, 원하면 사전승인제
  const all = readReviews(); all.push(rec); writeReviews(all);
  res.json({ ok:true, id:rec.id, approved:rec.approved });
});
// 관리자: 전체 후기(미승인 포함) 조회 / 승인·삭제
app.get('/api/reviews/admin', requireAdmin, (_q,res)=> res.json({ reviews: readReviews() }));
app.post('/api/reviews/moderate', requireAdmin, (req,res)=>{
  const b=req.body||{}; const id=String(b.id||''); const all=readReviews();
  if (b.delete) { writeReviews(all.filter(r=>r.id!==id)); return res.json({ ok:true, deleted:true }); }
  const r=all.find(x=>x.id===id); if(r) r.approved = b.approved!==false; writeReviews(all); res.json({ ok:true });
});

/* ---------- 견적서 문자(SMS/LMS) 발송 (#3) ----------
   우선순위: (1) 알리고(aligo) -> (2) 범용 SMS 웹훅 -> (3) 폴백(접수·관리자 알림)
   .env 예) ALIGO_KEY, ALIGO_USER, ALIGO_SENDER  (또는 SMS_WEBHOOK)                         */
const QUOTES = path.join(__dirname, 'quotes.json');
function readQuotes(){ try{ return JSON.parse(fs.readFileSync(QUOTES,'utf8')); }catch(e){ return []; } }
function writeQuotes(a){ try{ fs.writeFileSync(QUOTES, JSON.stringify(a,null,2)); }catch(e){} }
app.use('/api/quote/send', rateLimit('quotesend', 8, 60000)); // 문자 발송: IP당 8회/분
function onlyDigits(s){ return String(s||'').replace(/[^0-9]/g,''); }
async function sendSms(phone, msg, title){
  // (1) 알리고 SMS/LMS
  if (process.env.ALIGO_KEY && process.env.ALIGO_USER && process.env.ALIGO_SENDER) {
    const isLong = [...msg].length > 45; // 대략 SMS(90byte) 초과 -> LMS
    const form = new URLSearchParams({ key:process.env.ALIGO_KEY, user_id:process.env.ALIGO_USER,
      sender:process.env.ALIGO_SENDER, receiver:phone, msg, msg_type: isLong?'LMS':'SMS' });
    if (isLong && title) form.set('title', title);
    const testmode = process.env.ALIGO_TESTMODE === 'Y';
    if (testmode) form.set('testmode_yn', 'Y');   // 실제 발송·과금 없이 자격증명만 검증
    const r = await fetch('https://apis.aligo.in/send/', { method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:form });
    const j = await r.json().catch(()=>({}));
    if (String(j.result_code) === '1') return { delivered: !testmode, via: testmode?'aligo-test':'aligo', test: testmode };
    throw new Error('알리고 발송 실패: ' + (j.message || JSON.stringify(j)));
  }
  // (2) 범용 SMS 웹훅 (다른 문자 솔루션 연동용)
  if (process.env.SMS_WEBHOOK) {
    const r = await fetch(process.env.SMS_WEBHOOK, { method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ phone, msg, title }) });
    if (r.ok) return { delivered:true, via:'webhook' };
    throw new Error('SMS 웹훅 응답 ' + r.status);
  }
  return { delivered:false, via:'none' }; // 미설정 -> 폴백
}
async function verifyAddress(addr){
  if(!process.env.JUSO_KEY) return { ok:true, checked:false };
  try{
    const u='https://business.juso.go.kr/addrlink/addrLinkApi.do?confmKey='+process.env.JUSO_KEY+'&currentPage=1&countPerPage=1&resultType=json&keyword='+encodeURIComponent(addr);
    const r=await fetch(u); const j=await r.json();
    const cnt=Number((((j||{}).results||{}).common||{}).totalCount||0);
    return { ok: cnt>0, checked:true };
  }catch(e){ return { ok:true, checked:false, err:e.message }; }
}
app.post('/api/quote/send', async (req,res) => {
  const b = req.body || {};
  const cap = (s,n) => String(s==null?'':s).slice(0,n).trim();
  const name = cap(b.name,40), addr = cap(b.addr,120), summary = cap(b.summary,900);
  const phone = onlyDigits(b.phone);
  if (!/^01[016789][0-9]{7,8}$/.test(phone)) return res.status(400).json({ error: '휴대폰 번호를 정확히 입력해 주세요 (010으로 시작, 총 10~11자리)' });
  if (!summary) return res.status(400).json({ error: '견적 내용이 비어 있습니다' });
  if (!b.agreeReq) return res.status(400).json({ error: '개인정보 수집·이용 동의(필수)가 필요합니다' });
  if (!addr || addr.replace(/\s/g,'').length < 5) return res.status(400).json({ error: '주소를 입력해 주세요 (주소 검색으로 실제 주소 선택)' });
  const av = await verifyAddress(addr);
  if (av.checked && !av.ok) return res.status(400).json({ error: '입력하신 주소를 확인할 수 없어요. 주소 검색으로 실제 주소를 선택해 주세요.' });
  const rec = { id:'Q'+Date.now(), ts:new Date().toISOString(), name, phone, addr, summary,
    company:cap(b.company,40), total:Number(b.total)||0,
    agreeReq: !!b.agreeReq, agreeMkt: !!b.agreeMkt, zonecode: cap(b.zonecode,10), addrVerified: !!b.addrVerified,
    delivered:false, via:'none' };
  const msg = (name ? name+'님 ' : '') + '요청하신 매트 시공 견적서입니다.\n\n' + summary + '\n\n※ 현장 실측 후 최종 확정됩니다.';
  const title = '우리집 매트 견적서';
  try {
    const r = await sendSms(phone, msg, title);
    rec.delivered = r.delivered; rec.via = r.via;
    const all = readQuotes(); all.push(rec); writeQuotes(all);
    try { notifyLead({ ts:rec.ts, cust:{ name, phone:b.phone, addr, time:'-' }, company:rec.company, total:rec.total, danji:'' }); } catch(e){}
    if (r.delivered) return res.json({ ok:true, delivered:true, via:r.via });
    if (r.test) return res.json({ ok:true, delivered:false, test:true, via:'aligo-test', note:'테스트 모드 성공 — 알리고 자격증명·발신번호가 정상입니다. (실제 문자는 발송되지 않았어요)' });
    return res.json({ ok:true, delivered:false, note:'접수되었습니다. 담당자가 확인 후 문자로 견적서를 보내드립니다.' });
  } catch (e) {
    const all = readQuotes(); rec.error = e.message; all.push(rec); writeQuotes(all);
    try { notifyLead({ ts:rec.ts, cust:{ name, phone:b.phone, addr, time:'-' }, company:rec.company, total:rec.total, danji:'발송오류' }); } catch(_){}
    return res.status(200).json({ ok:true, delivered:false, note:'접수되었습니다. 담당자가 확인 후 문자로 견적서를 보내드립니다.' });
  }
});
app.get('/api/quotes', requireAdmin, (_q,res)=> res.json({ quotes: readQuotes() }));
/* 텔레그램 연결 셋업/점검 (관리자) */
app.get('/api/telegram/status', requireAdmin, (_q,res)=> res.json({ token: !!tgToken(), chatId: tgChatId()||null, source: process.env.TELEGRAM_CHAT_ID?'env':(tgChatId()?'auto':'none') }));
app.get('/api/telegram/setup', requireAdmin, async (_q,res)=>{
  if (!tgToken()) return res.json({ ok:false, message:'TELEGRAM_BOT_TOKEN이 없습니다(.env 확인 후 서버 재시작).' });
  const d = await tgDetect();
  if (d.ok) {
    const t = await tgSendTo(String(d.pick.id), '✅ 매트 견적앱 연결 완료!\n이제 새 견적·상담 신청이 이 그룹으로 전송됩니다.\n('+new Date().toLocaleString('ko-KR')+')');
    return res.json({ ok:true, chat:d.pick, testSent: t && t.ok !== false, groups:d.list });
  }
  return res.json({ ok:false, message:'봇이 있는 그룹을 못 찾았어요. 그룹에서 아무 메시지나 한 번 보낸 뒤(또는 봇 초대 직후) 이 주소를 다시 열어주세요.', groups:d.list||[] });
});
// 가상 고객 신청 발송 테스트 (관리자) — 그룹에 샘플 알림 1건 전송
app.get('/api/telegram/test-lead', requireAdmin, async (_q,res)=>{
  if (!tgToken()) return res.json({ ok:false, message:'TELEGRAM_BOT_TOKEN이 없습니다(.env 확인 후 서버 재시작).' });
  let id = tgChatId();
  if (!id) { const d = await tgDetect(); if (d.ok) id = String(d.pick.id); }
  if (!id) return res.json({ ok:false, message:'그룹이 아직 연결되지 않았어요. 그룹에 메시지 1개 보낸 뒤 /api/telegram/setup 을 먼저 여세요.' });
  const won = n => Number(n).toLocaleString('ko-KR');
  const text = '🧪 [가상] 새 견적/상담 신청 (발송 테스트)\n'
    + '이름: 홍길동\n연락처: 010-1234-5678\n주소: 서울 마포구 월드컵북로 100 101동 1001호\n'
    + '단지: 테스트 아파트\n매트: 800 매트\n합계(예상): ' + won(4400000) + '원\n희망시간: 오후\n메모: 테스트 신청입니다\n'
    + '시간: ' + new Date().toLocaleString('ko-KR') + '\n\n※ 실제 고객 신청이 아니라 발송 테스트입니다.';
  const r = await tgSendTo(id, text);
  const ok = r && r.ok !== false;
  res.json({ ok, chatId:id, telegram:r, message: ok ? '가상 고객 신청을 그룹으로 전송했습니다. 텔레그램을 확인하세요.' : '전송 실패 — 토큰/그룹 연결을 확인하세요.' });
});
// 문자 발송 준비상태 점검(관리자) — 실제 발송 없이 알리고 잔액/자격 확인
app.get('/api/sms/status', requireAdmin, async (_q,res) => {
  const cfg = { aligo: !!(process.env.ALIGO_KEY && process.env.ALIGO_USER && process.env.ALIGO_SENDER),
    sender: process.env.ALIGO_SENDER || '', webhook: !!process.env.SMS_WEBHOOK,
    testmode: process.env.ALIGO_TESTMODE === 'Y' };
  if (!cfg.aligo) return res.json({ ready: cfg.webhook, mode: cfg.webhook?'webhook':'none', cfg,
    message: cfg.webhook ? '웹훅 문자 연동이 설정되어 있습니다.' : '문자 게이트웨이가 설정되지 않았습니다(현재 문자 미발송·접수만).' });
  try {
    const form = new URLSearchParams({ key:process.env.ALIGO_KEY, user_id:process.env.ALIGO_USER });
    const r = await fetch('https://apis.aligo.in/remain/', { method:'POST',
      headers:{'Content-Type':'application/x-www-form-urlencoded'}, body:form });
    const j = await r.json().catch(()=>({}));
    if (String(j.result_code) === '1') return res.json({ ready:true, mode:'aligo', cfg,
      remain:{ SMS:j.SMS_CNT, LMS:j.LMS_CNT, MMS:j.MMS_CNT }, message:'알리고 연결 정상 — 발송 가능' });
    return res.json({ ready:false, mode:'aligo', cfg, message:'알리고 자격증명 오류: ' + (j.message||JSON.stringify(j)) });
  } catch (e) { return res.status(502).json({ ready:false, mode:'aligo', cfg, message:'알리고 연결 실패: ' + e.message }); }
});


/* ---------- 접속·세션 로깅 (서비스 개선 분석) ---------- */
const VISITS = path.join(__dirname, 'visits.json');
const SESS   = path.join(__dirname, 'sessions.json');
function readJson(p){ try{ return JSON.parse(fs.readFileSync(p,'utf8')); }catch(e){ return []; } }
function appendJson(p,rec){ const a=readJson(p); a.push(rec); try{ fs.writeFileSync(p, JSON.stringify(a,null,2)); }catch(e){} return a.length; }
// 접속(앱 로드)마다 기록
app.post('/api/visit', (req,res) => {
  const b = req.body || {};
  appendJson(VISITS, { ts:new Date().toISOString(), sessionId:b.sessionId||'', ua:req.headers['user-agent']||'', ref:b.ref||'' });
  res.json({ ok:true });
});
// 세션 종료/이탈 시 단계별 체류시간 + 입력정보 기록 (beacon)
app.post('/api/session', (req,res) => {
  let b = req.body; if (typeof b === 'string') { try{ b = JSON.parse(b); }catch(e){ b={}; } }
  appendJson(SESS, Object.assign({ ts:new Date().toISOString() }, b||{}));
  res.json({ ok:true });
});
app.get('/api/visits', requireAdmin, (_q,res) => res.json(readJson(VISITS)));
app.get('/api/sessions', requireAdmin, (_q,res) => res.json(readJson(SESS)));
// 단계별 평균·최대 체류시간 집계 (오래 머문 단계 = 개선 포인트)
app.get('/api/stats', requireAdmin, (_q,res) => {
  const sess = readJson(SESS); const agg = {};
  sess.forEach(s => (s.events||[]).forEach(e => {
    const k = e.step; agg[k] = agg[k] || { n:0, sum:0, max:0 };
    agg[k].n++; agg[k].sum += (e.dwellMs||0); agg[k].max = Math.max(agg[k].max, e.dwellMs||0);
  }));
  const dwell = Object.keys(agg).map(k => ({ step:+k, visits:agg[k].n, avgMs:Math.round(agg[k].sum/agg[k].n), maxMs:agg[k].max })).sort((a,b)=>b.avgMs-a.avgMs);
  res.json({ visits:readJson(VISITS).length, sessions:sess.length, leads:readLeads().length, dwell });
});

/* ---------- 소셜 로그인 (카카오·네이버) ---------- */
// 로그인 성공 → 프로필을 앱(localStorage)에 저장하고 앱으로 복귀
function loginDone(res, profile){
  const lit = JSON.stringify(JSON.stringify(profile));
  res.send('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:28px;color:#334">로그인 처리 중…<script>try{localStorage.setItem("mat_user",'+lit+');}catch(e){}location.replace("/");</script></body>');
}
app.get('/auth/status', (_q,res) => res.json({ kakao: !!KAKAO_ID, naver: !!NAVER_ID }));

// 카카오
app.get('/auth/kakao', (req,res) => {
  if (!KAKAO_ID) return res.status(503).send('카카오 미설정: KAKAO_CLIENT_ID 환경변수를 설정하세요 (README 참고).');
  const redirect = BASE_URL + '/auth/kakao/callback';
  res.redirect('https://kauth.kakao.com/oauth/authorize?response_type=code&client_id=' + KAKAO_ID + '&redirect_uri=' + encodeURIComponent(redirect));
});
app.get('/auth/kakao/callback', async (req,res) => {
  try{
    const redirect = BASE_URL + '/auth/kakao/callback';
    const tk = await (await fetch('https://kauth.kakao.com/oauth/token', { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({ grant_type:'authorization_code', client_id:KAKAO_ID, client_secret:KAKAO_SECRET, redirect_uri:redirect, code:req.query.code }) })).json();
    const me = await (await fetch('https://kapi.kakao.com/v2/user/me', { headers:{ Authorization:'Bearer ' + tk.access_token } })).json();
    const acc = me.kakao_account || {};
    loginDone(res, { provider:'kakao', id:me.id, name:(acc.profile&&acc.profile.nickname)||'', email:acc.email||'', phone:acc.phone_number||'' });
  }catch(e){ res.status(502).send('카카오 로그인 실패: ' + e.message); }
});

// 네이버 (state CSRF)
app.get('/auth/naver', (req,res) => {
  if (!NAVER_ID) return res.status(503).send('네이버 미설정: NAVER_CLIENT_ID 환경변수를 설정하세요 (README 참고).');
  const redirect = BASE_URL + '/auth/naver/callback';
  const state = Math.random().toString(36).slice(2);
  res.redirect('https://nid.naver.com/oauth2.0/authorize?response_type=code&client_id=' + NAVER_ID + '&redirect_uri=' + encodeURIComponent(redirect) + '&state=' + state);
});
app.get('/auth/naver/callback', async (req,res) => {
  try{
    const tk = await (await fetch('https://nid.naver.com/oauth2.0/token?grant_type=authorization_code&client_id=' + NAVER_ID + '&client_secret=' + NAVER_SECRET + '&code=' + req.query.code + '&state=' + (req.query.state||''))).json();
    const me = await (await fetch('https://openapi.naver.com/v1/nid/me', { headers:{ Authorization:'Bearer ' + tk.access_token } })).json();
    const r = me.response || {};
    loginDone(res, { provider:'naver', id:r.id, name:r.name||r.nickname||'', email:r.email||'', phone:r.mobile||'' });
  }catch(e){ res.status(502).send('네이버 로그인 실패: ' + e.message); }
});

// 모의 로그인 (키 없이 흐름 체험)
app.get('/auth/mock', (req,res) => loginDone(res, { provider:req.query.provider||'mock', name:req.query.name||'테스트고객', email:'test@example.com', phone:'' }));

purgeAll();
setInterval(purgeAll, 24*60*60*1000);
app.post('/api/admin/purge', requireAdmin, (_q,res) => res.json(purgeAll()));
app.listen(PORT, '0.0.0.0', () => {
  console.log('단지 프록시 실행 → http://localhost:' + PORT + '  (MOCK=' + MOCK + ', hasKey=' + !!KEY + ')');
  try { const os=require('os'); const ips=[]; Object.values(os.networkInterfaces()).forEach(arr=>arr.forEach(a=>{ if(a&&a.family==='IPv4'&&!a.internal) ips.push(a.address); }));
    if(ips.length) console.log('  같은 네트워크 다른 기기 접속 → ' + ips.map(ip=>'http://'+ip+':'+PORT).join('  /  ')); } catch(e){}
});

// 기동 후 텔레그램 그룹 자동연결(최초 1회)
setTimeout(function(){
  if (tgToken() && !tgChatId()) tgDetect().then(function(d){
    if (d.ok) console.log('[텔레그램] 그룹 자동연결:', d.pick.title, d.pick.id);
    else console.log('[텔레그램] 그룹 미탐지 — 그룹에 메시지 1개 보낸 뒤 /api/telegram/setup 열기');
  });
  else if (tgToken()) console.log('[텔레그램] 알림 대상 chat_id:', tgChatId());
}, 1500);
