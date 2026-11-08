import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js";
import { CONFIG } from "./config.js";
import { BABGIL_ABI, TKRW_ABI } from "./abi.js";

// ===========================================================================
// 상수 / 상태
// ===========================================================================

const STATUS = { NONE: 0, CREATED: 1, PAID: 2, REFUNDED: 3 };

const ERROR_KO = {
  ZeroAddress: "주소가 비어 있어요.",
  ZeroAmount: "금액은 1 이상이어야 해요.",
  AlreadyRegistered: "이미 등록된 매장이에요.",
  InvalidRewardRate: "적립률은 0~2000(20%) 사이여야 해요.",
  InvalidDuration: "결제 가능 시간은 1초~1일 사이여야 해요.",
  NotRegisteredStore: "등록된 매장 계정이 아니에요.",
  NotOrderStore: "이 주문을 만든 매장만 할 수 있어요.",
  NotOrderBuyer: "이 주문의 구매자만 결제할 수 있어요.",
  InvalidOrderStatus: "주문 상태가 맞지 않아요. (이미 결제 / 환불됐거나 없는 주문)",
  OrderExpired: "결제 가능 시간이 지났어요. 매장에 새 주문을 요청해 주세요.",
  PointsExceedAmount: "주문 금액보다 많은 포인트는 쓸 수 없어요.",
  InsufficientPoints: "보유 포인트가 부족해요.",
  AlreadyRewarded: "이미 적립한 주문이에요.",
  NoRewardForStore: "이 매장은 적립률이 0%라 적립할 수 없어요.",
  RewardedOrderNotRefundable: "포인트가 적립된 주문은 이번 범위에서 환불할 수 없어요.",
  ERC20InsufficientBalance: "잔액이 부족해요.",
  ERC20InsufficientAllowance: "tKRW 사용 승인(approve)이 부족해요.",
  SafeERC20FailedOperation: "토큰 전송이 실패해서 전체 거래가 취소됐어요.",
  OwnableUnauthorizedAccount: "운영자 계정만 할 수 있어요.",
};

// 읽기는 공개 RPC (지갑 없이도 현황 확인), 쓰기는 메타마스크
const readProvider = new ethers.JsonRpcProvider(CONFIG.rpcUrl, CONFIG.chainId, { staticNetwork: true });
const bgpR = new ethers.Contract(CONFIG.babgil, BABGIL_ABI, readProvider);
const tkrwR = new ethers.Contract(CONFIG.tkrw, TKRW_ABI, readProvider);
let bgpW, tkrwW, account;

const S = {
  isOwner: false,
  myStore: null, // { name, rewardBps }
  stores: [], // { addr, name, rewardBps, tkrw }
  orders: [],
  students: [], // 충전 이력이 있는 주소
  totals: null,
  points: 0n,
  bgp: 0n,
  tkrw: 0n,
  busy: false,
  orderMin: 10n,
  tabChosen: false,
};

// ===========================================================================
// 유틸
// ===========================================================================

const $ = (id) => document.getElementById(id);
const fmt = (v) => Number(v).toLocaleString("ko-KR");
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "-");
const same = (a, b) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const txUrl = (h) => `${CONFIG.explorer}/tx/${h}`;
const addrUrl = (a) => `${CONFIG.explorer}/address/${a}`;
const now = () => Math.floor(Date.now() / 1000);
const min = (a, b) => (a < b ? a : b);

function storeOf(addr) {
  return S.stores.find((s) => same(s.addr, addr));
}
function label(addr) {
  if (!addr) return "-";
  const st = storeOf(addr);
  if (st) return st.name;
  const custom = Object.entries(CONFIG.labels || {}).find(([a]) => same(a, addr));
  if (custom) return custom[1];
  return short(addr);
}
function storeIcon(name = "") {
  if (/카페|커피|cafe/i.test(name)) return "☕";
  if (/편의|마트/i.test(name)) return "🛒";
  return "🍚";
}
function parseIntValue(raw, name) {
  raw = String(raw).trim();
  if (!/^\d+$/.test(raw) || BigInt(raw) === 0n) throw new Error(`${name}을(를) 1 이상의 정수로 입력해 주세요.`);
  return BigInt(raw);
}

let toastTimer;
function toast(html, error = false) {
  const el = $("toast");
  el.innerHTML = html;
  el.className = "toast" + (error ? " error" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), error ? 8000 : 5000);
}

function explain(e) {
  if (e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001) return "메타마스크에서 거절했어요.";
  const name = e?.revert?.name;
  if (name) return ERROR_KO[name] ?? `거래가 거절됐어요: ${name}`;
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (data) {
    for (const c of [bgpR, tkrwR]) {
      try {
        const parsed = c.interface.parseError(typeof data === "string" ? data : data.data);
        if (parsed) return ERROR_KO[parsed.name] ?? `거래가 거절됐어요: ${parsed.name}`;
      } catch {}
    }
  }
  const msg = e?.shortMessage || e?.message || String(e);
  if (/insufficient funds/i.test(msg)) return "가스비(SepoliaETH)가 부족해요. faucet에서 받아 주세요.";
  return msg;
}

function showNotice(msg) { $("notice").textContent = msg; $("notice").classList.remove("hidden"); }
function hideNotice() { $("notice").classList.add("hidden"); }

// ===========================================================================
// 거래 실행 (진행 창 + 기록)
// ===========================================================================

const LOG_KEY = `babgil-txlog-${CONFIG.babgil}`;
function loadLog() { try { return JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch { return []; } }
function saveLog(log) { try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch {} }

function setBusy(b) {
  S.busy = b;
  document.querySelectorAll("[data-needs-wallet], .pay-card button, .ticket button").forEach((btn) => {
    if (btn.dataset.lock === "1") return; // 만료 등 고정 비활성
    btn.disabled = b || !account || !bgpW;
  });
}

function progRender(steps) {
  $("progSteps").innerHTML = steps
    .map(
      (s, i) => `<li class="${s.state}"><div class="st"><span>${s.state === "done" ? "✓" : s.state === "fail" ? "!" : i + 1}</span></div>
      <div class="lbl"><b>${esc(s.title)}</b><small>${s.note || ""}</small></div></li>`
    )
    .join("");
}

/** steps: [title, fn][] — 순서대로 서명/전송. null 단계는 건너뜀 */
async function flow(title, steps) {
  if (S.busy) return;
  steps = steps.filter(Boolean);
  const view = steps.map(([t]) => ({ title: t, state: "wait", note: "대기" }));
  $("progTitle").textContent = title;
  $("progMsg").textContent = steps.length > 1 ? `메타마스크 확인 창이 ${steps.length}번 떠요.` : "메타마스크 확인 창이 떠요.";
  $("progClose").classList.add("hidden");
  $("progress").classList.remove("hidden");
  progRender(view);
  setBusy(true);

  let ok = true;
  for (let i = 0; i < steps.length; i++) {
    const [t, fn] = steps[i];
    try {
      view[i] = { title: t, state: "sign", note: "메타마스크에서 확인을 눌러 주세요" };
      progRender(view);
      const tx = await fn();
      view[i] = { title: t, state: "mine", note: `블록에 기록되는 중… <a href="${txUrl(tx.hash)}" target="_blank">거래 보기</a>` };
      progRender(view);
      await tx.wait();
      view[i] = { title: t, state: "done", note: `<a href="${txUrl(tx.hash)}" target="_blank">${short(tx.hash)}</a>` };
      progRender(view);
      const log = loadLog();
      log.push({ time: new Date().toLocaleString("ko-KR"), title: t, from: account, hash: tx.hash });
      saveLog(log);
    } catch (e) {
      console.error(e);
      view[i] = { title: t, state: "fail", note: esc(explain(e)) };
      progRender(view);
      ok = false;
      break;
    }
  }

  setBusy(false);
  renderTxLog();
  $("progMsg").textContent = ok ? "완료됐어요." : "거래가 처리되지 않았어요. 잔액과 주문 상태는 그대로예요.";
  $("progClose").classList.remove("hidden");
  if (ok) setTimeout(() => $("progress").classList.add("hidden"), 1600);
  await refresh();
  loadEvents();
  return ok;
}

async function approveStep(amount, title) {
  const current = await tkrwR.allowance(account, CONFIG.babgil);
  if (current >= amount) return null;
  return [title ?? `tKRW ${fmt(amount)} 사용 승인`, () => tkrwW.approve(CONFIG.babgil, amount)];
}

// ===========================================================================
// 지갑 연결
// ===========================================================================

async function connect() {
  if (!window.ethereum) {
    showNotice("메타마스크가 없어요. 크롬에 메타마스크 확장 프로그램을 설치해 주세요.");
    return;
  }
  try {
    const provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);
    const net = await provider.getNetwork();
    if (net.chainId !== BigInt(CONFIG.chainId)) {
      showNotice(`메타마스크 네트워크를 ${CONFIG.chainName}로 바꿔 주세요.`);
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + CONFIG.chainId.toString(16) }] });
      } catch {}
      return; // chainChanged → 새로고침
    }
    const signer = await provider.getSigner();
    account = await signer.getAddress();
    bgpW = new ethers.Contract(CONFIG.babgil, BABGIL_ABI, signer);
    tkrwW = new ethers.Contract(CONFIG.tkrw, TKRW_ABI, signer);
    hideNotice();
    S.tabChosen = false;
    $("connectBtn").classList.add("hidden");
    $("hero").classList.add("hidden");
    document.querySelectorAll(".need-wallet").forEach((el) => el.classList.add("hidden"));
    await refresh();
  } catch (e) {
    console.error(e);
    showNotice(explain(e));
  }
}

// ===========================================================================
// 데이터
// ===========================================================================

async function refresh() {
  try {
    const [owner, supply, totalPoints, required, reserve, backed, count, storeAddrs] = await Promise.all([
      bgpR.owner(), bgpR.totalSupply(), bgpR.totalPoints(), bgpR.requiredReserve(),
      bgpR.reserveBalance(), bgpR.isFullyBacked(), bgpR.orderCount(), bgpR.getStores(),
    ]);
    S.totals = { supply, totalPoints, required, reserve, backed };

    S.stores = await Promise.all(
      storeAddrs.map(async (addr) => {
        const [s, bal] = await Promise.all([bgpR.stores(addr), tkrwR.balanceOf(addr)]);
        return { addr, name: s.name, rewardBps: Number(s.rewardBps), tkrw: bal };
      })
    );

    S.orders = await Promise.all(
      Array.from({ length: Number(count) }, (_, i) => i + 1).map(async (id) => {
        const o = await bgpR.getOrder(id);
        return {
          id, buyer: o.buyer, store: o.store, amount: o.amount, expiresAt: Number(o.expiresAt), status: Number(o.status),
          paidBgp: o.paidBgp, paidPoints: o.paidPoints, rewardPoints: o.rewardPoints,
        };
      })
    );

    if (account) {
      const [myStore, myTkrw, myBgp, myPoints] = await Promise.all([
        bgpR.stores(account), tkrwR.balanceOf(account), bgpR.balanceOf(account), bgpR.pointBalanceOf(account),
      ]);
      S.isOwner = same(owner, account);
      S.myStore = myStore.registered ? { name: myStore.name, rewardBps: Number(myStore.rewardBps) } : null;
      S.tkrw = myTkrw;
      S.bgp = myBgp;
      S.points = myPoints;
      renderHeader();
      renderStudent();
      renderStore();
      if (!S.tabChosen) {
        S.tabChosen = true;
        selectTab(S.myStore ? "store" : S.isOwner && !S.bgp ? "overview" : "student");
      }
    }
    renderOverview();
    setBusy(S.busy);
  } catch (e) {
    console.error(e);
    showNotice("컨트랙트를 읽지 못했어요. 네트워크 상태나 config.js를 확인해 주세요. " + explain(e));
  }
}

// ===========================================================================
// 렌더링 — 공통
// ===========================================================================

function renderHeader() {
  let role = "학생", cls = "", initial = "학";
  if (S.myStore) { role = S.myStore.name; cls = "store"; initial = storeIcon(S.myStore.name); }
  else if (S.isOwner) { role = "운영자"; cls = "owner"; initial = "운"; }
  else {
    const custom = Object.entries(CONFIG.labels || {}).find(([a]) => same(a, account));
    if (custom) { role = custom[1]; initial = custom[1].slice(0, 1); }
  }
  $("acctAvatar").textContent = initial;
  $("acctAvatar").className = "avatar " + cls;
  $("acctName").textContent = role;
  $("acctAddr").textContent = short(account);
  $("acct").classList.remove("hidden");
}

function selectTab(name) {
  document.querySelectorAll(".seg-btn").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${name}`));
  const needWallet = !account && name !== "overview";
  document.querySelectorAll(`#tab-${name} .need-wallet`).forEach((el) => el.classList.toggle("hidden", !needWallet));
  if (name === "student") document.querySelector(".wallet-area").classList.toggle("hidden", needWallet);
}

function timerText(expiresAt) {
  const left = expiresAt - now();
  if (left <= 0) return "만료됨";
  const m = Math.floor(left / 60), s = left % 60;
  return `${m}:${String(s).padStart(2, "0")} 남음`;
}

// ===========================================================================
// 학생
// ===========================================================================

function renderStudent() {
  $("sTotal").textContent = fmt(S.bgp + S.points);
  $("sBgp").textContent = fmt(S.bgp);
  $("sPoints").textContent = fmt(S.points);
  $("sTkrw").textContent = fmt(S.tkrw);

  // 입력 중인 값 보존 (자동 새로고침 대비)
  const kept = {};
  document.querySelectorAll("#pendingOrders .pay-card").forEach((el) => {
    kept[el.dataset.id] = { all: el.querySelector(".useAll")?.checked, pts: el.querySelector(".ptsInput")?.value, touched: el.dataset.touched === "1" };
  });

  const pending = S.orders.filter((o) => same(o.buyer, account) && o.status === STATUS.CREATED);
  const live = pending.filter((o) => o.expiresAt > now());
  $("pendingCount").textContent = live.length;
  $("pendingCount").classList.toggle("zero", !live.length);

  $("pendingOrders").innerHTML = pending.length
    ? pending
        .slice()
        .reverse()
        .map((o) => {
          const st = storeOf(o.store);
          const expired = o.expiresAt <= now();
          const maxPts = min(S.points, o.amount);
          return `
          <div class="pay-card ${expired ? "expired" : ""}" data-id="${o.id}">
            <div class="pay-head">
              <div class="store-ic">${storeIcon(st?.name)}</div>
              <div class="info"><b>${esc(label(o.store))}</b><small>주문 #${o.id} · <span class="timer" data-expires="${o.expiresAt}">${timerText(o.expiresAt)}</span></small></div>
              <div class="amt">${fmt(o.amount)}원</div>
            </div>
            <div class="split-bar"><i class="pt"></i><i class="bgp"></i></div>
            <div class="legend"><span><i class="pt"></i>포인트 <b class="vPt">0</b></span><span><i class="bgp"></i>BGP <b class="vBgp">0</b></span></div>
            <div class="pay-opts">
              <label class="switch-row"><input type="checkbox" class="switch useAll" ${maxPts > 0n ? "" : "disabled"} />
                <span>포인트 먼저 쓰기<small>보유 ${fmt(S.points)}P · 최대 ${fmt(maxPts)}P 사용 가능</small></span></label>
              <label class="custom-pts">직접 <input type="number" class="ptsInput" min="0" max="${maxPts}" step="1" value="0" />P</label>
            </div>
            <p class="warn-text hidden"></p>
            <button class="btn primary block lg payBtn" ${expired ? 'disabled data-lock="1"' : ""}>${expired ? "결제 시간이 지났어요" : "결제하기"}</button>
          </div>`;
        })
        .join("")
    : `<div class="empty-mini">아직 결제 요청이 없어요.<br />매장에서 주문을 등록하면 여기에 나타나요.</div>`;

  // 기본값: 포인트가 있으면 '포인트 먼저 쓰기' 켜기
  document.querySelectorAll("#pendingOrders .pay-card").forEach((card) => {
    const k = kept[card.dataset.id];
    const all = card.querySelector(".useAll");
    const input = card.querySelector(".ptsInput");
    if (k?.touched) {
      card.dataset.touched = "1";
      all.checked = !!k.all && !all.disabled;
      input.value = k.pts ?? "0";
    } else if (!all.disabled) {
      all.checked = true;
      const o = S.orders.find((x) => x.id === Number(card.dataset.id));
      input.value = String(min(S.points, o.amount));
    }
    updatePayCard(card);
  });

  // 이용 내역
  const mine = S.orders.filter((o) => same(o.buyer, account) && o.status !== STATUS.CREATED).reverse();
  $("myOrders").innerHTML = mine.length
    ? mine
        .map((o) => {
          const st = storeOf(o.store);
          const parts = [o.paidBgp > 0n ? `BGP ${fmt(o.paidBgp)}` : "", o.paidPoints > 0n ? `포인트 ${fmt(o.paidPoints)}` : ""].filter(Boolean).join(" + ");
          const refunded = o.status === STATUS.REFUNDED;
          const reward = o.rewardPoints > 0n
            ? `<span class="pill orange">+${fmt(o.rewardPoints)}P 적립</span>`
            : st?.rewardBps && !refunded ? `<span class="pill gray">적립 대기</span>` : "";
          return `<li class="hist">
            <div class="store-ic">${storeIcon(st?.name)}</div>
            <div class="mid"><b>${esc(label(o.store))}</b><small>주문 #${o.id} · ${parts || "-"}</small></div>
            <div class="right"><b class="${refunded ? "refund" : "minus"}">${fmt(o.amount)}원</b>${refunded ? `<span class="pill blue">환불 완료</span>` : reward}</div>
          </li>`;
        })
        .join("")
    : `<li class="hist"><div class="mid"><small>아직 이용 내역이 없어요.</small></div></li>`;
}

function updatePayCard(card) {
  const o = S.orders.find((x) => x.id === Number(card.dataset.id));
  if (!o) return;
  const raw = card.querySelector(".ptsInput").value.trim();
  const pts = /^\d+$/.test(raw) ? BigInt(raw) : 0n;
  const over = pts > o.amount || pts > S.points;
  const usePts = over ? 0n : pts;
  const need = o.amount - usePts;
  const total = Number(o.amount) || 1;
  card.querySelector(".split-bar .pt").style.width = `${(Number(usePts) / total) * 100}%`;
  card.querySelector(".split-bar .bgp").style.width = `${(Number(need) / total) * 100}%`;
  card.querySelector(".vPt").textContent = fmt(usePts);
  card.querySelector(".vBgp").textContent = fmt(need);

  const warn = card.querySelector(".warn-text");
  const btn = card.querySelector(".payBtn");
  let msg = "";
  if (over) msg = "포인트는 주문 금액과 보유 포인트를 넘을 수 없어요.";
  else if (need > S.bgp) msg = `BGP가 ${fmt(need - S.bgp)} 부족해요. 먼저 충전해 주세요.`;
  warn.textContent = msg;
  warn.classList.toggle("hidden", !msg);
  if (btn.dataset.lock !== "1") {
    btn.textContent = usePts > 0n ? `포인트 ${fmt(usePts)}P + ${fmt(need)} BGP 결제` : `${fmt(need)} BGP 결제`;
  }
}

// ===========================================================================
// 매장
// ===========================================================================

function renderStore() {
  const st = S.myStore;
  $("storeNotRegistered").classList.toggle("hidden", !!st || !account);
  $("storeArea").classList.toggle("hidden", !st);
  if (!st) return;

  const mine = S.orders.filter((o) => same(o.store, account)).reverse();
  const wait = mine.filter((o) => o.status === STATUS.CREATED);
  const todo = mine.filter((o) => o.status === STATUS.PAID && st.rewardBps > 0 && o.rewardPoints === 0n);
  const done = mine.filter((o) => !wait.includes(o) && !todo.includes(o));

  $("stIcon").textContent = storeIcon(st.name);
  $("stName").textContent = st.name;
  $("stRate").textContent = st.rewardBps ? `결제 금액의 ${st.rewardBps / 100}% 적립` : "적립 없음";
  $("stRate").className = "pill " + (st.rewardBps ? "orange" : "gray");
  $("stTkrw").textContent = fmt(S.tkrw);
  $("stWaiting").textContent = wait.filter((o) => o.expiresAt > now()).length;
  $("stPendingReward").textContent = todo.length;

  // 구매자 선택 목록 (충전 이력 + 라벨)
  const sel = $("orderBuyerSel");
  const prev = sel.value;
  const known = new Map();
  Object.entries(CONFIG.labels || {}).forEach(([a, n]) => { if (!storeOf(a) && n !== "운영자") known.set(a.toLowerCase(), { a, n }); });
  S.students.forEach((a) => { if (!known.has(a.toLowerCase()) && !storeOf(a)) known.set(a.toLowerCase(), { a, n: short(a) }); });
  sel.innerHTML =
    [...known.values()].map(({ a, n }) => `<option value="${a}">${esc(n)} · ${short(a)}</option>`).join("") +
    `<option value="__custom">직접 입력…</option>`;
  if ([...sel.options].some((o) => o.value === prev)) sel.value = prev;
  $("orderBuyer").classList.toggle("hidden", sel.value !== "__custom");
  updatePreview();

  const ticket = (o) => {
    const reward = (o.amount * BigInt(st.rewardBps)) / 10000n;
    const expired = o.status === STATUS.CREATED && o.expiresAt <= now();
    const canReward = o.status === STATUS.PAID && reward > 0n && o.rewardPoints === 0n;
    const canRefund = o.status === STATUS.PAID && o.rewardPoints === 0n;
    let meta = "";
    if (o.status === STATUS.CREATED) meta = expired ? `<span class="pill red">만료</span>` : `<span class="timer" data-expires="${o.expiresAt}">${timerText(o.expiresAt)}</span>`;
    else if (o.status === STATUS.REFUNDED) meta = `<span class="pill blue">환불 완료</span>`;
    else meta = [o.paidBgp > 0n ? `BGP ${fmt(o.paidBgp)}` : "", o.paidPoints > 0n ? `포인트 ${fmt(o.paidPoints)}` : ""].filter(Boolean).join(" + ") +
      (o.rewardPoints > 0n ? ` · <span class="pill orange">${fmt(o.rewardPoints)}P 적립</span>` : "");
    const actions = [
      canReward ? `<button class="btn point sm awardBtn" data-id="${o.id}">${fmt(reward)}P 적립</button>` : "",
      canRefund ? `<button class="btn danger sm refundBtn" data-id="${o.id}">환불</button>` : "",
    ].join("");
    return `<div class="ticket">
      <div class="t-top"><b>${fmt(o.amount)}원</b><small>#${o.id} · ${esc(label(o.buyer))}</small></div>
      <div class="t-meta">${meta}</div>
      ${actions ? `<div class="t-actions">${actions}</div>` : ""}
    </div>`;
  };
  const lane = (id, list, emptyMsg) => {
    $(id).innerHTML = list.length ? list.map(ticket).join("") : `<div class="empty-mini">${emptyMsg}</div>`;
    $(id + "N").textContent = list.length;
  };
  lane("laneWait", wait, "학생 결제를 기다리는 주문이 없어요");
  lane("laneTodo", todo, "적립할 주문이 없어요");
  lane("laneDone", done, "아직 없어요");
}

function updatePreview() {
  const sel = $("orderBuyerSel");
  const who = sel.value === "__custom" ? ($("orderBuyer").value.trim() ? short($("orderBuyer").value.trim()) : "구매자") : sel.selectedOptions[0]?.textContent?.split(" · ")[0] ?? "구매자";
  const amt = /^\d+$/.test($("orderAmt").value) ? fmt($("orderAmt").value) : "-";
  const st = S.myStore;
  const reward = st?.rewardBps && /^\d+$/.test($("orderAmt").value) ? (BigInt($("orderAmt").value) * BigInt(st.rewardBps)) / 10000n : 0n;
  $("orderPreview").innerHTML = `<b>${esc(who)}</b>에게 <b>${amt}원</b> 결제 요청을 보내요. ${S.orderMin}분 안에 결제해야 해요.` +
    (reward > 0n ? `<br />결제 후 적립하면 매장이 <b>${fmt(reward)} tKRW</b>를 부담하고 학생에게 <b>${fmt(reward)}P</b>가 쌓여요.` : "");
}

// ===========================================================================
// 전체 현황
// ===========================================================================

function renderOverview() {
  const t = S.totals;
  if (!t) return;
  const storeSum = S.stores.reduce((acc, s) => acc + s.tkrw, 0n);
  $("fSupply").textContent = fmt(t.supply);
  $("fPoints").textContent = fmt(t.totalPoints);
  $("fReserve").textContent = fmt(t.reserve);
  $("fStores").textContent = fmt(storeSum);
  $("fBacked").textContent = t.backed ? "재원 충분 ✓" : "재원 부족";
  $("fBacked").className = "fn-badge" + (t.backed ? "" : " bad");

  const max = Number(t.required > t.reserve ? t.required : t.reserve) || 1;
  $("gBgp").style.width = `${(Number(t.supply) / max) * 100}%`;
  $("gPt").style.width = `${(Number(t.totalPoints) / max) * 100}%`;
  $("gReserve").style.width = `${(Number(t.reserve) / max) * 100}%`;
  $("gRequired").textContent = fmt(t.required);
  $("gReserveV").textContent = fmt(t.reserve);

  $("storeList").innerHTML = S.stores.length
    ? S.stores
        .map((s) => `<div class="store-row"><div class="store-ic">${storeIcon(s.name)}</div>
          <div class="info"><b>${esc(s.name)}</b><small><a href="${addrUrl(s.addr)}" target="_blank">${short(s.addr)}</a></small></div>
          <span class="pill ${s.rewardBps ? "orange" : "gray"}">${s.rewardBps ? `${s.rewardBps / 100}% 적립` : "적립 없음"}</span>
          <div class="val">정산<b>${fmt(s.tkrw)}</b></div></div>`)
        .join("")
    : `<div class="empty-mini">등록된 매장이 없어요.</div>`;

  $("contractLinks").innerHTML = `<table>
    <tr><th>BabgilPoint (BGP)</th><td><a class="mono" href="${addrUrl(CONFIG.babgil)}" target="_blank">${CONFIG.babgil}</a></td></tr>
    <tr><th>tKRW</th><td><a class="mono" href="${addrUrl(CONFIG.tkrw)}" target="_blank">${CONFIG.tkrw}</a></td></tr>
    <tr><th>네트워크</th><td>${CONFIG.chainName} (${CONFIG.chainId})</td></tr></table>`;

  $("ownerArea").classList.toggle("hidden", !S.isOwner);
}

const EV_META = {
  StoreAdded: { ic: "🏪", cls: "" },
  Deposited: { ic: "💳", cls: "deposit" },
  Redeemed: { ic: "↩️", cls: "deposit" },
  OrderCreated: { ic: "🧾", cls: "" },
  OrderPaid: { ic: "✅", cls: "pay" },
  PointsAwarded: { ic: "⭐", cls: "reward" },
  OrderRefunded: { ic: "↩️", cls: "refund" },
};

async function loadEvents() {
  try {
    const head = await readProvider.getBlockNumber();
    const CHUNK = 45_000;
    const ranges = [];
    for (let from = CONFIG.deployBlock || 0; from <= head; from += CHUNK) ranges.push([from, Math.min(from + CHUNK - 1, head)]);
    const logs = (await Promise.all(ranges.map(([fromBlock, toBlock]) => readProvider.getLogs({ address: CONFIG.babgil, fromBlock, toBlock })))).flat();
    const events = logs
      .map((l) => {
        try {
          const p = bgpR.interface.parseLog(l);
          return p && EV_META[p.name] ? { fragment: p.fragment, args: p.args, blockNumber: l.blockNumber, index: l.index, transactionHash: l.transactionHash } : null;
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index);

    S.students = [...new Set(events.filter((e) => e.fragment.name === "Deposited").map((e) => e.args.student))];
    if (S.myStore) renderStore();

    const blocks = {};
    await Promise.all([...new Set(events.slice(0, 40).map((e) => e.blockNumber))].map(async (n) => {
      try { blocks[n] = (await readProvider.getBlock(n))?.timestamp; } catch {}
    }));
    const when = (n) => (blocks[n] ? new Date(blocks[n] * 1000).toLocaleString("ko-KR", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : `블록 ${n}`);

    const describe = (ev) => {
      const a = ev.args;
      switch (ev.fragment.name) {
        case "StoreAdded": return [`매장 등록 · ${esc(a.name)}`, `적립률 ${Number(a.rewardBps) / 100}%`];
        case "Deposited": return [`${esc(label(a.student))} 충전 ${fmt(a.amount)} BGP`, `tKRW ${fmt(a.amount)}을 맡기고 같은 수량의 BGP 발행`];
        case "Redeemed": return [`${esc(label(a.student))} BGP ${fmt(a.amount)} 반환`, `BGP 소각 → tKRW ${fmt(a.amount)} 돌려받음`];
        case "OrderCreated": return [`${esc(label(a.store))} 주문 #${a.orderId} · ${fmt(a.amount)}원`, `구매자 ${esc(label(a.buyer))}`];
        case "OrderPaid": {
          const parts = [a.pointsUsed > 0n ? `포인트 ${fmt(a.pointsUsed)}` : "", a.bgpUsed > 0n ? `BGP ${fmt(a.bgpUsed)}` : ""].filter(Boolean).join(" + ");
          return [`주문 #${a.orderId} 결제 · ${parts}`, `${esc(label(a.store))}에 ${fmt(a.bgpUsed + a.pointsUsed)} tKRW 바로 지급`];
        }
        case "PointsAwarded": return [`${esc(label(a.buyer))} +${fmt(a.points)}P 적립`, `${esc(label(a.store))}가 ${fmt(a.points)} tKRW를 재원으로 부담 (주문 #${a.orderId})`];
        case "OrderRefunded": return [`주문 #${a.orderId} 환불`, `BGP ${fmt(a.bgpRestored)} + 포인트 ${fmt(a.pointsRestored)} 복구`];
        default: return [ev.fragment.name, ""];
      }
    };

    $("events").innerHTML = events.length
      ? events
          .map((ev) => {
            const m = EV_META[ev.fragment.name];
            const [title, sub] = describe(ev);
            return `<li class="ev"><div class="ev-ic ${m.cls}">${m.ic}</div>
              <div class="ev-body"><b>${title}</b><small>${sub} · ${when(ev.blockNumber)}</small></div>
              <a class="ev-link" href="${txUrl(ev.transactionHash)}" target="_blank">${short(ev.transactionHash)} ↗</a></li>`;
          })
          .join("")
      : `<li class="muted">아직 기록이 없어요.</li>`;
  } catch (e) {
    console.error(e);
    $("events").innerHTML = `<li class="muted">기록을 불러오지 못했어요. (${esc(explain(e))})</li>`;
  }
}

function renderTxLog() {
  const log = loadLog();
  $("txLog").innerHTML = log.length
    ? `<div class="table-wrap"><table><tr><th>시간</th><th>작업</th><th>계정</th><th>거래</th></tr>
        ${log.slice().reverse().map((r) => `<tr><td>${esc(r.time)}</td><td>${esc(r.title)}</td><td>${esc(label(r.from))}</td><td><a class="mono" href="${txUrl(r.hash)}" target="_blank">${short(r.hash)}</a></td></tr>`).join("")}
      </table></div>`
    : `<div class="empty-mini">이 브라우저에서 보낸 거래가 여기에 쌓여요.</div>`;
}

// ===========================================================================
// 시트 (충전 / 반환)
// ===========================================================================

function openSheet(title, html, onReady) {
  $("sheetTitle").textContent = title;
  $("sheetBody").innerHTML = html;
  $("sheet").classList.remove("hidden");
  onReady?.();
}
function closeSheet() { $("sheet").classList.add("hidden"); }

function openDeposit() {
  openSheet(
    "BGP 충전",
    `<label class="field"><span>충전 금액</span><div class="amount-input"><input id="dAmt" type="number" min="1" step="1" value="10000" /><em>원</em></div></label>
     <div class="chips" style="margin-bottom:12px">
       <button type="button" data-v="5000">5,000</button><button type="button" data-v="10000">10,000</button><button type="button" data-v="20000">20,000</button>
     </div>
     <div class="summary">
       <div><span>지갑에서 나가는 tKRW</span><b id="dOut">-</b></div>
       <div><span>받는 BGP</span><b id="dIn">-</b></div>
       <div><span>지갑 tKRW 잔액</span><b>${fmt(S.tkrw)}</b></div>
     </div>
     <p class="muted">처음이거나 승인 한도가 부족하면 <b>사용 승인 → 충전</b> 순서로 메타마스크 확인을 두 번 해요.</p>
     <button id="dGo" class="btn primary block lg">충전하기</button>`,
    () => {
      const sync = () => {
        const v = /^\d+$/.test($("dAmt").value) ? fmt($("dAmt").value) : "-";
        $("dOut").textContent = `${v} tKRW`;
        $("dIn").textContent = `${v} BGP`;
      };
      sync();
      $("dAmt").addEventListener("input", sync);
      $("sheetBody").querySelectorAll("[data-v]").forEach((b) => b.addEventListener("click", () => { $("dAmt").value = b.dataset.v; sync(); }));
      $("dGo").addEventListener("click", guard(async () => {
        const amt = parseIntValue($("dAmt").value, "충전 금액");
        if (S.tkrw < amt) throw new Error(`지갑 tKRW가 부족해요 (보유 ${fmt(S.tkrw)}). '시연용 tKRW 받기'를 먼저 눌러 주세요.`);
        closeSheet();
        const approve = await approveStep(amt, `tKRW ${fmt(amt)} 사용 승인`);
        await flow("BGP 충전", [approve, [`${fmt(amt)} BGP 충전`, () => bgpW.deposit(amt)]]);
      }));
    }
  );
}

function openRedeem() {
  openSheet(
    "BGP 반환",
    `<label class="field"><span>반환할 BGP</span><div class="amount-input"><input id="rAmt" type="number" min="1" step="1" value="${S.bgp}" /><em>BGP</em></div></label>
     <div class="summary">
       <div><span>보유 BGP</span><b>${fmt(S.bgp)}</b></div>
       <div><span>돌려받는 tKRW</span><b id="rOut">-</b></div>
     </div>
     <p class="muted">BGP를 소각하고 같은 수량의 tKRW를 돌려받아요. 포인트는 무료 혜택이라 반환 대상이 아니에요.</p>
     <button id="rGo" class="btn primary block lg">반환하기</button>`,
    () => {
      const sync = () => ($("rOut").textContent = /^\d+$/.test($("rAmt").value) ? `${fmt($("rAmt").value)} tKRW` : "-");
      sync();
      $("rAmt").addEventListener("input", sync);
      $("rGo").addEventListener("click", guard(async () => {
        const amt = parseIntValue($("rAmt").value, "반환 금액");
        if (S.bgp < amt) throw new Error(`BGP가 부족해요 (보유 ${fmt(S.bgp)}).`);
        closeSheet();
        await flow("BGP 반환", [[`BGP ${fmt(amt)} 반환`, () => bgpW.redeem(amt)]]);
      }));
    }
  );
}

// ===========================================================================
// 이벤트 연결
// ===========================================================================

function guard(fn) {
  return async (...args) => {
    try { await fn(...args); } catch (e) { toast(`❌ ${esc(e.message || e)}`, true); }
  };
}

$("connectBtn").addEventListener("click", connect);
$("heroConnect").addEventListener("click", connect);
document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => { S.tabChosen = true; selectTab(b.dataset.tab); }));

$("openDeposit").addEventListener("click", openDeposit);
$("openRedeem").addEventListener("click", openRedeem);
$("faucetBtn").addEventListener("click", () => flow("시연용 tKRW 받기", [["tKRW 50,000 받기", () => tkrwW.faucet()]]));
$("sheet").addEventListener("click", (e) => { if (e.target.id === "sheet" || e.target.dataset.close !== undefined) closeSheet(); });
$("progClose").addEventListener("click", () => $("progress").classList.add("hidden"));

// 결제 카드
$("pendingOrders").addEventListener("input", (e) => {
  const card = e.target.closest(".pay-card");
  if (!card) return;
  card.dataset.touched = "1";
  if (e.target.classList.contains("ptsInput")) card.querySelector(".useAll").checked = false;
  updatePayCard(card);
});
$("pendingOrders").addEventListener("change", (e) => {
  const card = e.target.closest(".pay-card");
  if (!card || !e.target.classList.contains("useAll")) return;
  card.dataset.touched = "1";
  const o = S.orders.find((x) => x.id === Number(card.dataset.id));
  card.querySelector(".ptsInput").value = e.target.checked ? String(min(S.points, o.amount)) : "0";
  updatePayCard(card);
});
$("pendingOrders").addEventListener("click", guard(async (e) => {
  if (!e.target.classList.contains("payBtn")) return;
  const card = e.target.closest(".pay-card");
  const id = Number(card.dataset.id);
  const o = S.orders.find((x) => x.id === id);
  const raw = card.querySelector(".ptsInput").value.trim() || "0";
  if (!/^\d+$/.test(raw)) throw new Error("포인트는 0 이상의 정수로 입력해 주세요.");
  const pts = BigInt(raw);
  if (pts > o.amount) throw new Error(ERROR_KO.PointsExceedAmount);
  if (pts > S.points) throw new Error(ERROR_KO.InsufficientPoints);
  if (o.amount - pts > S.bgp) throw new Error(`BGP가 부족해요 (필요 ${fmt(o.amount - pts)}, 보유 ${fmt(S.bgp)}).`);
  const desc = pts > 0n ? `포인트 ${fmt(pts)}P + BGP ${fmt(o.amount - pts)}` : `BGP ${fmt(o.amount)}`;
  await flow(`${label(o.store)} 결제`, [[`주문 #${id} · ${desc}`, () => bgpW.pay(id, pts)]]);
}));

// 매장 주문 등록
$("orderBuyerSel").addEventListener("change", () => {
  $("orderBuyer").classList.toggle("hidden", $("orderBuyerSel").value !== "__custom");
  updatePreview();
});
$("orderBuyer").addEventListener("input", updatePreview);
$("orderAmt").addEventListener("input", updatePreview);
$("amtChips").addEventListener("click", (e) => {
  if (!e.target.dataset.amt) return;
  $("orderAmt").value = e.target.dataset.amt;
  updatePreview();
});
$("minChips").addEventListener("click", (e) => {
  if (!e.target.dataset.min) return;
  S.orderMin = BigInt(e.target.dataset.min);
  $("minChips").querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target));
  updatePreview();
});
$("createOrderBtn").addEventListener("click", guard(async () => {
  const sel = $("orderBuyerSel").value;
  const raw = sel === "__custom" ? $("orderBuyer").value.trim() : sel;
  if (!ethers.isAddress(raw)) throw new Error("구매자 주소가 올바르지 않아요.");
  const buyer = ethers.getAddress(raw);
  const amt = parseIntValue($("orderAmt").value, "금액");
  await flow("결제 요청 보내기", [[`${label(buyer)}에게 ${fmt(amt)}원 주문`, () => bgpW.createOrder(buyer, amt, S.orderMin * 60n)]]);
}));

// 매장 주문 카드 (적립 / 환불)
$("storeArea").addEventListener("click", guard(async (e) => {
  const id = Number(e.target.dataset.id);
  const o = S.orders.find((x) => x.id === id);
  if (!o) return;
  if (e.target.classList.contains("awardBtn")) {
    const reward = (o.amount * BigInt(S.myStore.rewardBps)) / 10000n;
    if (S.tkrw < reward) throw new Error(`적립 재원 tKRW가 부족해요 (필요 ${fmt(reward)}).`);
    const approve = await approveStep(reward, `적립 재원 tKRW ${fmt(reward)} 사용 승인`);
    await flow("포인트 적립", [approve, [`주문 #${id} · ${label(o.buyer)}에게 ${fmt(reward)}P 적립`, () => bgpW.awardPoints(id)]]);
  }
  if (e.target.classList.contains("refundBtn")) {
    if (!confirm(`주문 #${id}을(를) 환불할까요?\n\n매장이 ${fmt(o.amount)} tKRW를 반환하고,\n학생에게 BGP ${fmt(o.paidBgp)} + 포인트 ${fmt(o.paidPoints)}가 복구돼요.`)) return;
    if (S.tkrw < o.amount) throw new Error(`반환할 tKRW가 부족해요 (필요 ${fmt(o.amount)}).`);
    const approve = await approveStep(o.amount, `반환할 tKRW ${fmt(o.amount)} 사용 승인`);
    await flow("주문 환불", [approve, [`주문 #${id} 환불`, () => bgpW.refund(id)]]);
  }
}));

// 운영자
$("addStoreBtn").addEventListener("click", guard(async () => {
  const raw = $("storeAddr").value.trim();
  if (!ethers.isAddress(raw)) throw new Error("매장 주소가 올바르지 않아요.");
  const name = $("storeName").value.trim();
  if (!name) throw new Error("매장 이름을 입력해 주세요.");
  const bps = $("storeBps").value.trim();
  if (!/^\d+$/.test(bps) || Number(bps) > 2000) throw new Error(ERROR_KO.InvalidRewardRate);
  await flow("매장 등록", [[`${name} 등록`, () => bgpW.addStore(ethers.getAddress(raw), name, Number(bps))]]);
}));

$("reloadEvents").addEventListener("click", loadEvents);
$("clearLog").addEventListener("click", () => {
  if (confirm("이 브라우저에 저장된 거래 기록을 지울까요? (블록체인 기록은 그대로예요)")) { saveLog([]); renderTxLog(); }
});
$("copyLog").addEventListener("click", async () => {
  const rows = loadLog().map((r) => `| ${r.time} | ${r.title} | ${label(r.from)} | ${txUrl(r.hash)} |`);
  const md = ["| 시간 | 작업 | 계정 | 거래 |", "|---|---|---|---|", ...rows].join("\n");
  try { await navigator.clipboard.writeText(md); toast("표를 클립보드에 복사했어요."); } catch { toast("복사하지 못했어요.", true); }
});

// 타이머 (1초) / 자동 새로고침 (15초)
setInterval(() => {
  document.querySelectorAll("[data-expires]").forEach((el) => {
    const left = Number(el.dataset.expires) - now();
    el.textContent = timerText(Number(el.dataset.expires));
    el.classList.toggle("urgent", left > 0 && left < 60);
  });
}, 1000);
setInterval(() => { if (!S.busy && $("sheet").classList.contains("hidden")) refresh(); }, 15000);

// 보기 전용 모드: ?as=0x주소 → 그 계정의 화면을 서명 없이 보여줘요 (발표 화면용)
const asParam = new URLSearchParams(location.search).get("as");
if (asParam && ethers.isAddress(asParam)) {
  account = ethers.getAddress(asParam);
  $("hero").classList.add("hidden");
  $("connectBtn").classList.add("hidden");
  showNotice(`보기 전용 모드예요 (${short(account)}). 거래를 하려면 주소 뒤의 ?as=... 를 지우고 지갑을 연결해 주세요.`);
} else if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged", () => location.reload());
  window.ethereum.request({ method: "eth_accounts" }).then((accs) => accs?.length && connect()).catch(() => {});
}

// 시작: 지갑 없이도 전체 현황은 보여줘요
$("netName").textContent = CONFIG.chainName;
selectTab("overview");
renderTxLog();
setBusy(false);
refresh();
loadEvents();
