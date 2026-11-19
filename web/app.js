import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js";
import { CONFIG } from "./config.js";
import { BABGIL_ABI, TKRW_ABI } from "./abi.js";

// ===========================================================================
// 상수 / 상태
// ===========================================================================

const STATUS = { NONE: 0, PLACED: 1, ACCEPTED: 2, REJECTED: 3, CANCELLED: 4, REFUNDED: 5 };

const ERROR_KO = {
  ZeroAddress: "주소가 비어 있어요.",
  ZeroAmount: "금액은 1 이상이어야 해요.",
  EmptyName: "이름을 입력해 주세요.",
  AlreadyRegistered: "이미 등록된 매장이에요.",
  InvalidRewardRate: "적립률은 0~2000(20%) 사이여야 해요.",
  NotRegisteredStore: "등록된 매장이 아니에요.",
  MenuFull: "메뉴는 50개까지 등록할 수 있어요.",
  InvalidMenuItem: "없는 메뉴예요.",
  MenuItemUnavailable: "지금 판매하지 않는 메뉴가 있어요.",
  EmptyOrder: "메뉴를 하나 이상 골라 주세요.",
  TooManyLines: "한 번에 20가지 메뉴까지 주문할 수 있어요.",
  LengthMismatch: "주문 정보가 올바르지 않아요.",
  InvalidQuantity: "수량은 1~100개 사이여야 해요.",
  NotOrderStore: "이 주문을 받은 매장만 할 수 있어요.",
  NotOrderBuyer: "주문한 학생만 취소할 수 있어요. (접수 시간이 지나면 누구나 돌려줄 수 있어요)",
  InvalidOrderStatus: "주문 상태가 맞지 않아요. (이미 처리됐거나 없는 주문)",
  AcceptWindowClosed: "접수 시간(30분)이 지나서 접수할 수 없어요. 거절해서 학생에게 돌려주세요.",
  PointsExceedAmount: "주문 금액보다 많은 포인트는 쓸 수 없어요.",
  InsufficientPoints: "보유 포인트가 부족해요.",
  AlreadyRewarded: "이미 적립한 주문이에요.",
  NoReward: "이 주문은 적립할 포인트가 없어요. (적립률 0% 매장이거나 포인트로만 결제)",
  RewardedOrderNotRefundable: "포인트가 적립된 주문은 환불할 수 없어요.",
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
  menus: {}, // 매장 주소(소문자) → [{ id, name, price, available }]
  cart: { store: null, qty: {} }, // 학생 장바구니 (메뉴 번호 → 수량)
  usePoints: true,
  totals: null,
  points: 0n,
  bgp: 0n,
  tkrw: 0n,
  busy: false,
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
function menuImage(store, name) {
  const entry = Object.entries(CONFIG.menuImages || {}).find(([a]) => same(a, store));
  return entry?.[1]?.[name.trim()] ?? null;
}
function menuOf(store) {
  return S.menus[store?.toLowerCase()] ?? [];
}
function linesText(o) {
  const menu = menuOf(o.store);
  return (o.lines || []).map((l) => `${menu[l.itemId]?.name ?? `메뉴 ${l.itemId}`}${l.quantity > 1 ? ` ×${l.quantity}` : ""}`).join(", ");
}
function paidText(o) {
  return [o.paidPoints > 0n ? `포인트 ${fmt(o.paidPoints)}` : "", o.paidBgp > 0n ? `BGP ${fmt(o.paidBgp)}` : ""].filter(Boolean).join(" + ") || "-";
}
function rewardOf(o) {
  const st = storeOf(o.store);
  return st ? (o.paidBgp * BigInt(st.rewardBps)) / 10000n : 0n;
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
  document.querySelectorAll("[data-needs-wallet], .pay-card button, .ticket button, .menu-admin button").forEach((btn) => {
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
        const [s, bal, menu] = await Promise.all([bgpR.stores(addr), tkrwR.balanceOf(addr), bgpR.getMenu(addr)]);
        S.menus[addr.toLowerCase()] = menu.map((m, id) => ({ id, name: m.name, price: m.price, available: m.available }));
        return { addr, name: s.name, rewardBps: Number(s.rewardBps), tkrw: bal };
      })
    );

    S.orders = await Promise.all(
      Array.from({ length: Number(count) }, (_, i) => i + 1).map(async (id) => {
        const [o, lines] = await Promise.all([bgpR.getOrder(id), bgpR.getOrderLines(id)]);
        return {
          id, buyer: o.buyer, store: o.store, amount: o.amount, placedAt: Number(o.placedAt), deadline: Number(o.acceptDeadline),
          status: Number(o.status), paidBgp: o.paidBgp, paidPoints: o.paidPoints, rewardPoints: o.rewardPoints,
          lines: lines.map((l) => ({ itemId: Number(l.itemId), quantity: Number(l.quantity), unitPrice: l.unitPrice })),
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
  if (left <= 0) return "접수 시간 지남";
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

  renderOrderForm();

  // 진행 중인 주문 (접수 대기)
  const pending = S.orders.filter((o) => same(o.buyer, account) && o.status === STATUS.PLACED).reverse();
  $("pendingCount").textContent = pending.length;
  $("pendingCount").classList.toggle("zero", !pending.length);
  $("pendingOrders").innerHTML = pending.length
    ? pending
        .map((o) => {
          const st = storeOf(o.store);
          const over = o.deadline <= now();
          return `
          <div class="pay-card ${over ? "expired" : ""}" data-id="${o.id}">
            <div class="pay-head">
              <div class="store-ic">${storeIcon(st?.name)}</div>
              <div class="info"><b>${esc(label(o.store))}</b><small>주문 #${o.id} · ${over ? "접수 시간 지남" : `접수 대기 · <span class="timer" data-expires="${o.deadline}">${timerText(o.deadline)}</span>`}</small></div>
              <div class="amt">${fmt(o.amount)}원</div>
            </div>
            <p class="order-lines">${esc(linesText(o))}<br />결제: ${paidText(o)} · 금고에 잡혀 있어요</p>
            <button class="btn ${over ? "primary" : ""} block cancelBtn" data-id="${o.id}">${over ? "돌려받기" : "주문 취소"}</button>
          </div>`;
        })
        .join("")
    : `<div class="empty-mini">접수를 기다리는 주문이 없어요.</div>`;

  // 이용 내역
  const mine = S.orders.filter((o) => same(o.buyer, account) && o.status !== STATUS.PLACED).reverse();
  $("myOrders").innerHTML = mine.length
    ? mine
        .map((o) => {
          const st = storeOf(o.store);
          let badge = "";
          let cls = "minus";
          if (o.status === STATUS.ACCEPTED) {
            badge = o.rewardPoints > 0n
              ? `<span class="pill orange">+${fmt(o.rewardPoints)}P 적립</span>`
              : rewardOf(o) > 0n ? `<span class="pill gray">적립 대기</span>` : `<span class="pill gray">접수 완료</span>`;
          } else {
            cls = "refund";
            badge = {
              [STATUS.REJECTED]: `<span class="pill red">매장 거절 · 돌려받음</span>`,
              [STATUS.CANCELLED]: `<span class="pill gray">취소 · 돌려받음</span>`,
              [STATUS.REFUNDED]: `<span class="pill blue">환불 완료</span>`,
            }[o.status] ?? "";
          }
          return `<li class="hist">
            <div class="store-ic">${storeIcon(st?.name)}</div>
            <div class="mid"><b>${esc(label(o.store))}</b><small>#${o.id} · ${esc(linesText(o))} · ${paidText(o)}</small></div>
            <div class="right"><b class="${cls}">${fmt(o.amount)}원</b>${badge}</div>
          </li>`;
        })
        .join("")
    : `<li class="hist"><div class="mid"><small>아직 이용 내역이 없어요.</small></div></li>`;
}

function cartInfo() {
  const menu = menuOf(S.cart.store);
  const lines = Object.entries(S.cart.qty)
    .map(([id, q]) => ({ item: menu[Number(id)], qty: q }))
    .filter((l) => l.item && l.qty > 0);
  const total = lines.reduce((acc, l) => acc + l.item.price * BigInt(l.qty), 0n);
  const pts = S.usePoints ? min(S.points, total) : 0n;
  const bgp = total - pts;
  const st = storeOf(S.cart.store);
  const reward = st ? (bgp * BigInt(st.rewardBps)) / 10000n : 0n;
  return { lines, total, pts, bgp, reward };
}

function renderOrderForm() {
  if (!S.cart.store || !storeOf(S.cart.store)) S.cart = { store: S.stores[0]?.addr ?? null, qty: {} };
  $("storePicker").innerHTML = S.stores.length
    ? S.stores
        .map((st) => `<button type="button" class="store-pick ${same(st.addr, S.cart.store) ? "on" : ""}" data-store="${st.addr}">
          <span class="store-ic">${storeIcon(st.name)}</span>${esc(st.name)}${st.rewardBps ? ` <small>${st.rewardBps / 100}% 적립</small>` : ""}</button>`)
        .join("")
    : `<div class="empty-mini">등록된 매장이 없어요.</div>`;

  const menu = menuOf(S.cart.store);
  $("menuGrid").innerHTML = menu.length
    ? menu
        .map((m) => {
          const q = S.cart.qty[m.id] ?? 0;
          const img = menuImage(S.cart.store, m.name);
          const pic = img
            ? `<img class="menu-pic" src="${esc(img)}" alt="${esc(m.name)}" loading="lazy" />`
            : `<div class="menu-pic none">${storeIcon(storeOf(S.cart.store)?.name)}</div>`;
          return `<div class="menu-item ${q ? "sel" : ""} ${m.available ? "" : "off"}">
            ${pic}
            <b>${esc(m.name)}</b><span class="price">${fmt(m.price)}원${m.available ? "" : " · 품절"}</span>
            <div class="qty"><button type="button" data-item="${m.id}" data-d="-1" ${q ? "" : "disabled"}>−</button><span>${q}</span>
              <button type="button" data-item="${m.id}" data-d="1" ${m.available && q < 100 ? "" : "disabled"}>+</button></div>
          </div>`;
        })
        .join("")
    : `<div class="empty-mini">이 매장은 아직 메뉴가 없어요.</div>`;

  const c = cartInfo();
  $("cartBox").classList.toggle("hidden", !c.lines.length);
  if (!c.lines.length) return;
  $("cartLines").innerHTML = c.lines
    .map((l) => `<li><span>${esc(l.item.name)} × ${l.qty}</span><span>${fmt(l.item.price * BigInt(l.qty))}원</span></li>`)
    .join("");
  $("cartTotal").textContent = `${fmt(c.total)}원`;
  const t = Number(c.total) || 1;
  $("cartBarPt").style.width = `${(Number(c.pts) / t) * 100}%`;
  $("cartBarBgp").style.width = `${(Number(c.bgp) / t) * 100}%`;
  $("cartPt").textContent = fmt(c.pts);
  $("cartBgp").textContent = fmt(c.bgp);
  $("cartReward").textContent = c.reward > 0n ? `접수 후 +${fmt(c.reward)}P 적립 예정` : "";
  $("usePoints").checked = S.usePoints && S.points > 0n;
  $("usePoints").disabled = S.points === 0n;
  $("pointsHint").textContent = `보유 ${fmt(S.points)}P · 포인트로 낸 금액에는 적립되지 않아요`;
  const warn = c.bgp > S.bgp ? `BGP가 ${fmt(c.bgp - S.bgp)} 부족해요. 먼저 충전해 주세요.` : "";
  $("cartWarn").textContent = warn;
  $("cartWarn").classList.toggle("hidden", !warn);
  $("placeOrderBtn").textContent = c.pts > 0n
    ? `포인트 ${fmt(c.pts)}P + ${fmt(c.bgp)} BGP로 주문하기`
    : `${fmt(c.bgp)} BGP로 주문하기`;
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
  const wait = mine.filter((o) => o.status === STATUS.PLACED);
  const todo = mine.filter((o) => o.status === STATUS.ACCEPTED && o.rewardPoints === 0n && rewardOf(o) > 0n);
  const done = mine.filter((o) => !wait.includes(o) && !todo.includes(o));

  $("stIcon").textContent = storeIcon(st.name);
  $("stName").textContent = st.name;
  $("stRate").textContent = st.rewardBps ? `BGP 결제액의 ${st.rewardBps / 100}% 적립` : "적립 없음";
  $("stRate").className = "pill " + (st.rewardBps ? "orange" : "gray");
  $("stTkrw").textContent = fmt(S.tkrw);
  $("stWaiting").textContent = wait.filter((o) => o.deadline > now()).length;
  $("stPendingReward").textContent = todo.length;

  // 메뉴 관리 (수정 중인 값은 자동 새로고침에도 유지)
  const kept = {};
  document.querySelectorAll("#menuAdmin li[data-dirty='1']").forEach((li) => {
    kept[li.dataset.id] = { price: li.querySelector(".mPrice").value, on: li.querySelector(".mOn").checked };
  });
  const menu = menuOf(account);
  $("menuAdmin").innerHTML = menu.length
    ? menu
        .map((m) => {
          const k = kept[m.id];
          const img = menuImage(account, m.name);
          return `<li data-id="${m.id}" class="${m.available ? "" : "off"}" ${k ? 'data-dirty="1"' : ""}>
            ${img ? `<img class="menu-thumb" src="${esc(img)}" alt="" />` : `<span class="menu-thumb none">${storeIcon(st.name)}</span>`}
            <b title="${esc(m.name)}">${esc(m.name)}</b>
            <input class="mPrice" type="number" min="1" step="1" value="${k ? esc(k.price) : m.price}" />
            <input type="checkbox" class="switch mOn" title="판매 중" ${(k ? k.on : m.available) ? "checked" : ""} />
            <button class="btn tiny saveMenuBtn" data-id="${m.id}">저장</button>
          </li>`;
        })
        .join("")
    : `<li class="empty-mini">아직 메뉴가 없어요. 아래에서 추가해 주세요.</li>`;

  const ticket = (o) => {
    const reward = rewardOf(o);
    const over = o.status === STATUS.PLACED && o.deadline <= now();
    let meta = "";
    let actions = "";
    if (o.status === STATUS.PLACED) {
      meta = over
        ? `<span class="pill red">접수 시간 지남</span>`
        : `<span class="timer" data-expires="${o.deadline}">${timerText(o.deadline)}</span> · ${paidText(o)}`;
      actions = (over ? "" : `<button class="btn primary sm acceptBtn" data-id="${o.id}">접수</button>`) +
        `<button class="btn danger sm rejectBtn" data-id="${o.id}">${over ? "학생에게 돌려주기" : "거절"}</button>`;
    } else {
      const state = {
        [STATUS.REJECTED]: `<span class="pill red">거절</span>`,
        [STATUS.CANCELLED]: `<span class="pill gray">취소됨</span>`,
        [STATUS.REFUNDED]: `<span class="pill blue">환불 완료</span>`,
      }[o.status];
      meta = state ?? paidText(o) + (o.rewardPoints > 0n ? ` · <span class="pill orange">${fmt(o.rewardPoints)}P 적립</span>` : "");
      if (o.status === STATUS.ACCEPTED && o.rewardPoints === 0n) {
        actions = (reward > 0n ? `<button class="btn point sm awardBtn" data-id="${o.id}">${fmt(reward)}P 적립</button>` : "") +
          `<button class="btn danger sm refundBtn" data-id="${o.id}">환불</button>`;
      }
    }
    return `<div class="ticket">
      <div class="t-top"><b>${fmt(o.amount)}원</b><small>#${o.id} · ${esc(label(o.buyer))}</small></div>
      <div class="t-lines">${esc(linesText(o))}</div>
      <div class="t-meta">${meta}</div>
      ${actions ? `<div class="t-actions">${actions}</div>` : ""}
    </div>`;
  };
  const lane = (id, list, emptyMsg) => {
    $(id).innerHTML = list.length ? list.map(ticket).join("") : `<div class="empty-mini">${emptyMsg}</div>`;
    $(id + "N").textContent = list.length;
  };
  lane("laneWait", wait, "들어온 주문이 없어요");
  lane("laneTodo", todo, "적립할 주문이 없어요");
  lane("laneDone", done, "아직 없어요");
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
  $("fBacked").textContent = t.backed ? "금고 충분 ✓" : "금고 부족";
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
  MenuItemAdded: { ic: "📋", cls: "" },
  MenuItemUpdated: { ic: "📋", cls: "" },
  Deposited: { ic: "💳", cls: "deposit" },
  Redeemed: { ic: "↩️", cls: "deposit" },
  OrderPlaced: { ic: "🧾", cls: "" },
  OrderAccepted: { ic: "✅", cls: "pay" },
  OrderRejected: { ic: "✋", cls: "refund" },
  OrderCancelled: { ic: "✋", cls: "refund" },
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
        case "MenuItemAdded": return [`${esc(label(a.store))} 메뉴 추가 · ${esc(a.name)}`, `${fmt(a.price)}원`];
        case "MenuItemUpdated": return [`${esc(label(a.store))} 메뉴 변경 · ${esc(menuOf(a.store)[Number(a.itemId)]?.name ?? `#${a.itemId}`)}`, `${fmt(a.price)}원 · ${a.available ? "판매 중" : "판매 중지"}`];
        case "OrderPlaced": {
          const parts = [a.pointsUsed > 0n ? `포인트 ${fmt(a.pointsUsed)}` : "", a.bgpUsed > 0n ? `BGP ${fmt(a.bgpUsed)}` : ""].filter(Boolean).join(" + ");
          return [`${esc(label(a.buyer))} → ${esc(label(a.store))} 주문 #${a.orderId} · ${fmt(a.amount)}원`, `${parts} 결제, 금고에 잡아둠`];
        }
        case "OrderAccepted": return [`${esc(label(a.store))} 주문 #${a.orderId} 접수`, `금고에서 ${fmt(a.amount)} tKRW 정산`];
        case "OrderRejected": return [`${esc(label(a.store))} 주문 #${a.orderId} 거절`, `${esc(label(a.buyer))}에게 BGP·포인트 돌려줌`];
        case "OrderCancelled": return [`주문 #${a.orderId} 취소`, `${esc(label(a.buyer))}에게 BGP·포인트 돌려줌`];
        case "PointsAwarded": return [`${esc(label(a.buyer))} +${fmt(a.points)}P 적립`, `${esc(label(a.store))}가 ${fmt(a.points)} tKRW를 금고에 넣어 부담 (주문 #${a.orderId})`];
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

// 학생 주문
$("storePicker").addEventListener("click", (e) => {
  const b = e.target.closest("[data-store]");
  if (!b || same(b.dataset.store, S.cart.store)) return;
  S.cart = { store: b.dataset.store, qty: {} };
  renderOrderForm();
});
$("menuGrid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-item]");
  if (!b) return;
  const id = Number(b.dataset.item);
  const q = Math.max(0, Math.min(100, (S.cart.qty[id] ?? 0) + Number(b.dataset.d)));
  if (q) S.cart.qty[id] = q;
  else delete S.cart.qty[id];
  renderOrderForm();
});
$("usePoints").addEventListener("change", (e) => { S.usePoints = e.target.checked; renderOrderForm(); });
$("placeOrderBtn").addEventListener("click", guard(async () => {
  const c = cartInfo();
  if (!c.lines.length) throw new Error(ERROR_KO.EmptyOrder);
  if (c.lines.some((l) => !l.item.available)) throw new Error(ERROR_KO.MenuItemUnavailable);
  if (c.bgp > S.bgp) throw new Error(`BGP가 부족해요 (필요 ${fmt(c.bgp)}, 보유 ${fmt(S.bgp)}).`);
  const store = S.cart.store;
  const ids = c.lines.map((l) => l.item.id);
  const qtys = c.lines.map((l) => l.qty);
  const desc = c.pts > 0n ? `포인트 ${fmt(c.pts)}P + BGP ${fmt(c.bgp)}` : `BGP ${fmt(c.bgp)}`;
  const what = c.lines.map((l) => `${l.item.name}×${l.qty}`).join(", ");
  const ok = await flow(`${label(store)} 주문`, [[`${what} · ${desc}`, () => bgpW.placeOrder(store, ids, qtys, c.pts)]]);
  if (ok) { S.cart.qty = {}; renderOrderForm(); }
}));
$("pendingOrders").addEventListener("click", guard(async (e) => {
  if (!e.target.classList.contains("cancelBtn")) return;
  const id = Number(e.target.dataset.id);
  if (!confirm(`주문 #${id}을(를) 취소하고 결제한 BGP·포인트를 돌려받을까요?`)) return;
  await flow("주문 취소", [[`주문 #${id} 취소 · 돌려받기`, () => bgpW.cancelOrder(id)]]);
}));

// 매장 메뉴 관리
$("addMenuBtn").addEventListener("click", guard(async () => {
  const name = $("newMenuName").value.trim();
  if (!name) throw new Error("메뉴 이름을 입력해 주세요.");
  const price = parseIntValue($("newMenuPrice").value, "가격");
  const ok = await flow("메뉴 추가", [[`${name} ${fmt(price)}원`, () => bgpW.addMenuItem(name, price)]]);
  if (ok) { $("newMenuName").value = ""; $("newMenuPrice").value = ""; }
}));
const markDirty = (e) => { const li = e.target.closest("li"); if (li) li.dataset.dirty = "1"; };
$("menuAdmin").addEventListener("input", markDirty);
$("menuAdmin").addEventListener("change", markDirty);
$("menuAdmin").addEventListener("click", guard(async (e) => {
  if (!e.target.classList.contains("saveMenuBtn")) return;
  const li = e.target.closest("li");
  const id = Number(li.dataset.id);
  const price = parseIntValue(li.querySelector(".mPrice").value, "가격");
  const on = li.querySelector(".mOn").checked;
  const name = menuOf(account)[id]?.name ?? `메뉴 ${id}`;
  delete li.dataset.dirty;
  await flow("메뉴 변경", [[`${name} · ${fmt(price)}원 · ${on ? "판매 중" : "판매 중지"}`, () => bgpW.updateMenuItem(id, price, on)]]);
}));

// 매장 주문 카드 (접수 / 거절 / 적립 / 환불)
$("storeArea").addEventListener("click", guard(async (e) => {
  const id = Number(e.target.dataset.id);
  const o = S.orders.find((x) => x.id === id);
  if (!o) return;
  if (e.target.classList.contains("acceptBtn")) {
    await flow("주문 접수", [[`주문 #${id} 접수 · ${fmt(o.amount)} tKRW 정산`, () => bgpW.acceptOrder(id)]]);
  }
  if (e.target.classList.contains("rejectBtn")) {
    if (!confirm(`주문 #${id}을(를) 거절할까요?\n\n학생에게 ${paidText(o)}가 그대로 돌아가요.`)) return;
    await flow("주문 거절", [[`주문 #${id} 거절 · 학생에게 돌려주기`, () => bgpW.rejectOrder(id)]]);
  }
  if (e.target.classList.contains("awardBtn")) {
    const reward = rewardOf(o);
    if (S.tkrw < reward) throw new Error(`적립에 쓸 tKRW가 부족해요 (필요 ${fmt(reward)}).`);
    const approve = await approveStep(reward, `적립용 tKRW ${fmt(reward)} 사용 승인`);
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
