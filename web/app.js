import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.4/dist/ethers.min.js";
import { CONFIG } from "./config.js";
import { BABGIL_ABI, TKRW_ABI } from "./abi.js";

// ---------------------------------------------------------------------------
// 상수 / 상태
// ---------------------------------------------------------------------------

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
  OrderExpired: "결제 가능 시간이 지난 주문이에요. 매장에서 주문을 새로 등록해 주세요.",
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

let provider, signer, account, bgp, tkrw;
const S = {
  isOwner: false,
  myStore: null, // { name, rewardBps }
  stores: [], // { addr, name, rewardBps }
  orders: [],
  points: 0n,
  bgp: 0n,
  tkrw: 0n,
  busy: false,
};

// ---------------------------------------------------------------------------
// 유틸
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const fmt = (v) => Number(v).toLocaleString("ko-KR");
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "-");
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const txUrl = (h) => `${CONFIG.explorer}/tx/${h}`;
const addrUrl = (a) => `${CONFIG.explorer}/address/${a}`;
const now = () => Math.floor(Date.now() / 1000);

function label(addr) {
  if (!addr) return "-";
  const st = S.stores.find((s) => same(s.addr, addr));
  if (st) return st.name;
  const custom = Object.entries(CONFIG.labels || {}).find(([a]) => same(a, addr));
  if (custom) return custom[1];
  if (same(addr, account)) return "나";
  return short(addr);
}

function parseIntInput(id, name) {
  const raw = $(id).value.trim();
  if (!/^\d+$/.test(raw) || BigInt(raw) === 0n) throw new Error(`${name}을(를) 1 이상의 정수로 입력해 주세요.`);
  return BigInt(raw);
}

function parseAddrInput(id, name) {
  const raw = $(id).value.trim();
  if (!ethers.isAddress(raw)) throw new Error(`${name}이(가) 올바른 주소가 아니에요.`);
  return ethers.getAddress(raw);
}

let toastTimer;
function toast(html, { error = false, sticky = false } = {}) {
  const el = $("toast");
  el.innerHTML = html;
  el.className = "toast" + (error ? " error" : "");
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => el.classList.add("hidden"), error ? 9000 : 6000);
}

function explain(e) {
  if (e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001) return "메타마스크에서 거절했어요.";
  const name = e?.revert?.name;
  if (name) return ERROR_KO[name] ?? `거래가 거절됐어요: ${name}`;
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  if (data) {
    for (const c of [bgp, tkrw]) {
      try {
        const parsed = c.interface.parseError(typeof data === "string" ? data : data.data);
        if (parsed) return ERROR_KO[parsed.name] ?? `거래가 거절됐어요: ${parsed.name}`;
      } catch {}
    }
  }
  const msg = e?.shortMessage || e?.message || String(e);
  if (/insufficient funds/i.test(msg)) return "가스비(SepoliaETH)가 부족해요.";
  return msg;
}

// ---------------------------------------------------------------------------
// 거래 실행 + 기록
// ---------------------------------------------------------------------------

const LOG_KEY = `babgil-txlog-${CONFIG.babgil}`;
function loadLog() {
  try { return JSON.parse(localStorage.getItem(LOG_KEY) || "[]"); } catch { return []; }
}
function saveLog(log) {
  try { localStorage.setItem(LOG_KEY, JSON.stringify(log)); } catch {}
}

function setBusy(b) {
  S.busy = b;
  document.querySelectorAll("[data-needs-wallet], .order button, .actions button").forEach((btn) => (btn.disabled = b || !account));
}

/** 거래 한 건 실행. 실패하면 예외를 다시 던져서 다음 단계를 멈춰요. */
async function sendTx(title, fn) {
  toast(`<b>${esc(title)}</b> · 메타마스크에서 확인해 주세요…`, { sticky: true });
  const tx = await fn();
  toast(`<b>${esc(title)}</b> · 블록에 기록되는 중… <a href="${txUrl(tx.hash)}" target="_blank">거래 보기</a>`, { sticky: true });
  await tx.wait();
  const log = loadLog();
  log.push({ time: new Date().toLocaleString("ko-KR"), title, from: account, hash: tx.hash });
  saveLog(log);
  renderTxLog();
  toast(`✅ <b>${esc(title)}</b> 완료 · <a href="${txUrl(tx.hash)}" target="_blank">Etherscan</a>`);
  return tx;
}

/** 여러 단계(승인 → 실행 등)를 순서대로. */
async function flow(steps) {
  if (S.busy) return;
  setBusy(true);
  try {
    for (const [title, fn] of steps.filter(Boolean)) {
      await sendTx(title, fn);
    }
  } catch (e) {
    console.error(e);
    toast(`❌ ${esc(explain(e))}`, { error: true });
  } finally {
    setBusy(false);
    await refresh();
  }
}

async function ensureAllowance(amount, titlePrefix) {
  const current = await tkrw.allowance(account, CONFIG.babgil);
  if (current >= amount) return null;
  return [`${titlePrefix} · tKRW ${fmt(amount)} 사용 승인`, () => tkrw.approve(CONFIG.babgil, amount)];
}

// ---------------------------------------------------------------------------
// 연결
// ---------------------------------------------------------------------------

async function connect() {
  if (!window.ethereum) {
    showNotice("메타마스크가 없어요. 크롬에 메타마스크 확장 프로그램을 설치해 주세요.");
    return;
  }
  if (/^0x0+$/.test(CONFIG.babgil) || /^0x0+$/.test(CONFIG.tkrw)) {
    showNotice("web/config.js에 TKRW와 BabgilPoint 주소를 먼저 넣어 주세요.");
    return;
  }
  try {
    provider = new ethers.BrowserProvider(window.ethereum);
    await provider.send("eth_requestAccounts", []);

    const net = await provider.getNetwork();
    if (net.chainId !== BigInt(CONFIG.chainId)) {
      showNotice(`메타마스크 네트워크를 ${CONFIG.chainName}로 바꿔 주세요.`);
      try {
        await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x" + CONFIG.chainId.toString(16) }] });
      } catch {}
      return; // chainChanged 이벤트로 새로고침돼요
    }

    signer = await provider.getSigner();
    account = await signer.getAddress();
    bgp = new ethers.Contract(CONFIG.babgil, BABGIL_ABI, signer);
    tkrw = new ethers.Contract(CONFIG.tkrw, TKRW_ABI, signer);
    hideNotice();
    $("connectBtn").classList.add("hidden");
    await refresh();
    loadEvents();
  } catch (e) {
    console.error(e);
    showNotice(explain(e));
  }
}

function showNotice(msg) { $("notice").textContent = msg; $("notice").classList.remove("hidden"); }
function hideNotice() { $("notice").classList.add("hidden"); }

// ---------------------------------------------------------------------------
// 데이터 읽기
// ---------------------------------------------------------------------------

async function refresh() {
  if (!account) return;
  try {
    const [owner, myStore, myTkrw, myBgp, myPoints, supply, totalPoints, required, reserve, backed, count, storeAddrs] = await Promise.all([
      bgp.owner(),
      bgp.stores(account),
      tkrw.balanceOf(account),
      bgp.balanceOf(account),
      bgp.pointBalanceOf(account),
      bgp.totalSupply(),
      bgp.totalPoints(),
      bgp.requiredReserve(),
      bgp.reserveBalance(),
      bgp.isFullyBacked(),
      bgp.orderCount(),
      bgp.getStores(),
    ]);

    S.isOwner = same(owner, account);
    S.myStore = myStore.registered ? { name: myStore.name, rewardBps: Number(myStore.rewardBps) } : null;
    S.tkrw = myTkrw;
    S.bgp = myBgp;
    S.points = myPoints;

    S.stores = await Promise.all(
      storeAddrs.map(async (addr) => {
        const s = await bgp.stores(addr);
        return { addr, name: s.name, rewardBps: Number(s.rewardBps) };
      })
    );

    const ids = Array.from({ length: Number(count) }, (_, i) => i + 1);
    S.orders = await Promise.all(
      ids.map(async (id) => {
        const o = await bgp.getOrder(id);
        return {
          id,
          buyer: o.buyer,
          store: o.store,
          amount: o.amount,
          expiresAt: Number(o.expiresAt),
          status: Number(o.status),
          paidBgp: o.paidBgp,
          paidPoints: o.paidPoints,
          rewardPoints: o.rewardPoints,
        };
      })
    );

    renderHeader();
    renderStudent();
    renderStore();
    renderOverview({ supply, totalPoints, required, reserve, backed });
    setBusy(S.busy);
  } catch (e) {
    console.error(e);
    showNotice("컨트랙트를 읽지 못했어요. config.js 주소와 네트워크(Sepolia)를 확인해 주세요. " + explain(e));
  }
}

// ---------------------------------------------------------------------------
// 화면 그리기
// ---------------------------------------------------------------------------

function renderHeader() {
  const roles = [];
  if (S.isOwner) roles.push("운영자");
  if (S.myStore) roles.push(S.myStore.name);
  if (!roles.length) roles.push("학생");
  $("account").innerHTML = `<b title="${account}">${short(account)}</b>${roles.map((r) => `<span class="role">${esc(r)}</span>`).join("")}`;
  $("account").classList.remove("hidden");
}

function statusBadge(o) {
  if (o.status === STATUS.CREATED && o.expiresAt < now()) return `<span class="badge expired">만료</span>`;
  return {
    [STATUS.CREATED]: `<span class="badge created">결제 대기</span>`,
    [STATUS.PAID]: `<span class="badge paid">결제 완료</span>`,
    [STATUS.REFUNDED]: `<span class="badge refunded">환불 완료</span>`,
  }[o.status] ?? "-";
}

function remaining(o) {
  const left = o.expiresAt - now();
  if (left <= 0) return "만료됨";
  const m = Math.floor(left / 60), s = left % 60;
  return `${m}분 ${String(s).padStart(2, "0")}초 남음`;
}

function rewardCell(o) {
  const st = S.stores.find((s) => same(s.addr, o.store));
  if (o.rewardPoints > 0n) return `적립 완료 ${fmt(o.rewardPoints)}점`;
  if (o.status !== STATUS.PAID || !st || st.rewardBps === 0) return "-";
  return "적립 대기";
}

function renderStudent() {
  // 15초 자동 새로고침 때 입력 중인 포인트 값이 지워지지 않게 보존
  const kept = {};
  document.querySelectorAll("#pendingOrders .ptsInput").forEach((el) => {
    const all = document.querySelector(`.useAll[data-id="${el.dataset.id}"]`);
    kept[el.dataset.id] = { value: el.value, all: all?.checked };
  });

  $("sBgp").textContent = fmt(S.bgp);
  $("sPoints").textContent = fmt(S.points);
  $("sTkrw").textContent = fmt(S.tkrw);

  const pending = S.orders.filter((o) => same(o.buyer, account) && o.status === STATUS.CREATED);
  $("pendingOrders").innerHTML = pending.length
    ? pending
        .map((o) => {
          const expired = o.expiresAt < now();
          const maxPts = S.points < o.amount ? S.points : o.amount;
          return `
        <div class="order" data-order="${o.id}">
          <div>
            <div class="title">#${o.id} · ${esc(label(o.store))} · ${fmt(o.amount)}원</div>
            <div class="meta" data-expires="${o.expiresAt}">${remaining(o)}</div>
            <div class="split" id="split-${o.id}"></div>
          </div>
          <div class="controls">
            <label><input type="checkbox" class="useAll" data-id="${o.id}" ${maxPts > 0n ? "" : "disabled"}/> 포인트 전액 사용 (최대 ${fmt(maxPts)})</label>
            <label>포인트 <input type="number" class="ptsInput" data-id="${o.id}" min="0" max="${maxPts}" step="1" value="0" /></label>
            <button class="btn primary payBtn" data-id="${o.id}" ${expired ? "disabled" : ""}>${expired ? "만료됨" : "결제"}</button>
          </div>
        </div>`;
        })
        .join("")
    : `<p class="empty">결제할 주문이 없어요.</p>`;
  pending.forEach((o) => {
    const k = kept[o.id];
    if (k) {
      document.querySelector(`.ptsInput[data-id="${o.id}"]`).value = k.value;
      const all = document.querySelector(`.useAll[data-id="${o.id}"]`);
      if (all && !all.disabled) all.checked = !!k.all;
    }
    updateSplit(o.id);
  });

  const mine = S.orders.filter((o) => same(o.buyer, account) && o.status !== STATUS.CREATED).reverse();
  $("myOrders").innerHTML = mine.length
    ? `<div class="table-wrap"><table>
        <tr><th>#</th><th>매장</th><th class="num">금액</th><th class="num">BGP</th><th class="num">포인트</th><th>상태</th><th>적립</th></tr>
        ${mine
          .map(
            (o) => `<tr><td>${o.id}</td><td>${esc(label(o.store))}</td><td class="num">${fmt(o.amount)}</td>
              <td class="num">${fmt(o.paidBgp)}</td><td class="num">${fmt(o.paidPoints)}</td><td>${statusBadge(o)}</td><td>${rewardCell(o)}</td></tr>`
          )
          .join("")}
      </table></div>`
    : `<p class="empty">아직 주문이 없어요.</p>`;
}

function updateSplit(id) {
  const o = S.orders.find((x) => x.id === id);
  const input = document.querySelector(`.ptsInput[data-id="${id}"]`);
  const el = $(`split-${id}`);
  if (!o || !input || !el) return;
  let pts = /^\d+$/.test(input.value) ? BigInt(input.value) : 0n;
  const over = pts > o.amount || pts > S.points;
  const bgpNeed = pts > o.amount ? 0n : o.amount - pts;
  el.innerHTML = over
    ? `<span style="color:var(--red)">포인트는 주문 금액과 보유 포인트를 넘을 수 없어요.</span>`
    : `포인트 <b>${fmt(pts)}</b> + BGP <b>${fmt(bgpNeed)}</b> = ${fmt(o.amount)}원${bgpNeed > S.bgp ? ` <span style="color:var(--red)">(BGP 부족)</span>` : ""}`;
}

function renderStore() {
  const st = S.myStore;
  $("storeNotRegistered").classList.toggle("hidden", !!st);
  $("storeArea").classList.toggle("hidden", !st);
  if (!st) return;

  const mine = S.orders.filter((o) => same(o.store, account)).reverse();
  const waiting = mine.filter((o) => o.status === STATUS.PAID && st.rewardBps > 0 && o.rewardPoints === 0n);

  $("stName").textContent = st.name;
  $("stRate").textContent = st.rewardBps ? `적립률 ${st.rewardBps / 100}%` : "적립 없음";
  $("stTkrw").textContent = fmt(S.tkrw);
  $("stPendingReward").textContent = fmt(waiting.length);

  $("storeOrders").innerHTML = mine.length
    ? `<div class="table-wrap"><table>
        <tr><th>#</th><th>구매자</th><th class="num">금액</th><th class="num">BGP</th><th class="num">포인트</th><th>상태</th><th>적립</th><th></th></tr>
        ${mine
          .map((o) => {
            const reward = (o.amount * BigInt(st.rewardBps)) / 10000n;
            const canReward = o.status === STATUS.PAID && reward > 0n && o.rewardPoints === 0n;
            const canRefund = o.status === STATUS.PAID && o.rewardPoints === 0n;
            const actions = [
              canReward ? `<button class="btn primary small awardBtn" data-id="${o.id}">${fmt(reward)}점 적립</button>` : "",
              canRefund ? `<button class="btn warn small refundBtn" data-id="${o.id}">환불</button>` : "",
            ].join(" ");
            const remain = o.status === STATUS.CREATED ? `<div class="meta" data-expires="${o.expiresAt}">${remaining(o)}</div>` : "";
            return `<tr><td>${o.id}</td><td>${esc(label(o.buyer))}</td><td class="num">${fmt(o.amount)}</td>
              <td class="num">${fmt(o.paidBgp)}</td><td class="num">${fmt(o.paidPoints)}</td>
              <td>${statusBadge(o)}${remain}</td><td>${rewardCell(o)}</td><td class="actions">${actions}</td></tr>`;
          })
          .join("")}
      </table></div>`
    : `<p class="empty">등록한 주문이 없어요.</p>`;
}

function renderOverview({ supply, totalPoints, required, reserve, backed }) {
  $("oSupply").textContent = fmt(supply);
  $("oPoints").textContent = fmt(totalPoints);
  $("oRequired").textContent = fmt(required);
  $("oReserve").textContent = fmt(reserve);
  const b = $("backedBadge");
  b.textContent = backed ? `재원 충분 · 보관 ${fmt(reserve)} ≥ 필요 ${fmt(required)}` : `재원 부족 · 보관 ${fmt(reserve)} < 필요 ${fmt(required)}`;
  b.className = "banner " + (backed ? "ok" : "bad");

  $("storeList").innerHTML = S.stores.length
    ? `<table><tr><th>이름</th><th>주소</th><th class="num">적립률</th></tr>
        ${S.stores
          .map((s) => `<tr><td>${esc(s.name)}</td><td><a class="addr" href="${addrUrl(s.addr)}" target="_blank">${short(s.addr)}</a></td><td class="num">${s.rewardBps / 100}%</td></tr>`)
          .join("")}</table>`
    : `<p class="empty">등록된 매장이 없어요.</p>`;

  $("contractLinks").innerHTML = `
    <table>
      <tr><td>BabgilPoint (BGP)</td><td><a class="addr" href="${addrUrl(CONFIG.babgil)}" target="_blank">${short(CONFIG.babgil)}</a></td></tr>
      <tr><td>tKRW</td><td><a class="addr" href="${addrUrl(CONFIG.tkrw)}" target="_blank">${short(CONFIG.tkrw)}</a></td></tr>
      <tr><td>네트워크</td><td>${CONFIG.chainName}</td></tr>
    </table>`;

  $("ownerArea").classList.toggle("hidden", !S.isOwner);
}

// 온체인 이벤트 → 사람이 읽는 기록
async function loadEvents() {
  if (!bgp) return;
  $("events").innerHTML = `<p class="empty">불러오는 중…</p>`;
  try {
    const names = ["StoreAdded", "Deposited", "Redeemed", "OrderCreated", "OrderPaid", "PointsAwarded", "OrderRefunded"];
    const lists = await Promise.all(names.map((n) => bgp.queryFilter(bgp.filters[n](), CONFIG.deployBlock || 0)));
    const events = lists.flat().sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index);

    const describe = (ev) => {
      const a = ev.args;
      switch (ev.fragment.name) {
        case "StoreAdded": return `매장 등록 · ${esc(a.name)} (적립률 ${Number(a.rewardBps) / 100}%)`;
        case "Deposited": return `충전 · ${esc(label(a.student))} · tKRW ${fmt(a.amount)} → BGP ${fmt(a.amount)}`;
        case "Redeemed": return `반환 · ${esc(label(a.student))} · BGP ${fmt(a.amount)} → tKRW ${fmt(a.amount)}`;
        case "OrderCreated": return `주문 #${a.orderId} 등록 · ${esc(label(a.store))} → ${esc(label(a.buyer))} · ${fmt(a.amount)}원`;
        case "OrderPaid": return `주문 #${a.orderId} 결제 · 포인트 ${fmt(a.pointsUsed)} + BGP ${fmt(a.bgpUsed)} → ${esc(label(a.store))}에 ${fmt(a.bgpUsed + a.pointsUsed)} tKRW 지급`;
        case "PointsAwarded": return `주문 #${a.orderId} 적립 · ${esc(label(a.store))}가 ${fmt(a.points)} tKRW 부담 → ${esc(label(a.buyer))}에게 ${fmt(a.points)}점`;
        case "OrderRefunded": return `주문 #${a.orderId} 환불 · ${esc(label(a.store))}가 반환 → BGP ${fmt(a.bgpRestored)} + 포인트 ${fmt(a.pointsRestored)} 복구`;
        default: return ev.fragment.name;
      }
    };

    $("events").innerHTML = events.length
      ? `<div class="table-wrap"><table><tr><th>블록</th><th>내용</th><th>거래</th></tr>
          ${events.map((ev) => `<tr><td>${ev.blockNumber}</td><td>${describe(ev)}</td><td><a class="addr" href="${txUrl(ev.transactionHash)}" target="_blank">${short(ev.transactionHash)}</a></td></tr>`).join("")}
        </table></div>`
      : `<p class="empty">아직 기록이 없어요.</p>`;
  } catch (e) {
    console.error(e);
    $("events").innerHTML = `<p class="empty">기록을 불러오지 못했어요. config.js의 deployBlock을 배포 블록 번호로 넣으면 나아질 수 있어요. (${esc(explain(e))})</p>`;
  }
}

function renderTxLog() {
  const log = loadLog();
  $("txLog").innerHTML = log.length
    ? `<div class="table-wrap"><table><tr><th>시간</th><th>작업</th><th>보낸 계정</th><th>거래 해시</th></tr>
        ${log
          .slice()
          .reverse()
          .map((r) => `<tr><td>${esc(r.time)}</td><td>${esc(r.title)}</td><td>${esc(label(r.from))}</td><td><a class="addr" href="${txUrl(r.hash)}" target="_blank">${short(r.hash)}</a></td></tr>`)
          .join("")}
      </table></div>`
    : `<p class="empty">아직 없어요.</p>`;
}

// ---------------------------------------------------------------------------
// 이벤트 핸들러
// ---------------------------------------------------------------------------

function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      toast(`❌ ${esc(e.message || e)}`, { error: true });
    }
  };
}

$("connectBtn").addEventListener("click", connect);

document.querySelectorAll(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    document.querySelectorAll(".panel").forEach((p) => p.classList.toggle("hidden", p.id !== `tab-${tab.dataset.tab}`));
  })
);

$("faucetBtn").addEventListener("click", () => flow([["시연용 tKRW 받기", () => tkrw.faucet()]]));

$("depositBtn").addEventListener(
  "click",
  guard(async () => {
    const amt = parseIntInput("depositAmt", "충전 금액");
    if (S.tkrw < amt) throw new Error(`지갑 tKRW가 부족해요 (보유 ${fmt(S.tkrw)}). '시연용 tKRW 받기'를 먼저 눌러 주세요.`);
    const approve = await ensureAllowance(amt, "충전 1/2");
    await flow([approve, [`충전 ${approve ? "2/2" : ""} · ${fmt(amt)} BGP`, () => bgp.deposit(amt)]]);
  })
);

$("redeemBtn").addEventListener(
  "click",
  guard(async () => {
    const amt = parseIntInput("redeemAmt", "반환 금액");
    if (S.bgp < amt) throw new Error(`BGP가 부족해요 (보유 ${fmt(S.bgp)}).`);
    await flow([[`BGP ${fmt(amt)} 반환`, () => bgp.redeem(amt)]]);
  })
);

// 결제 대기 주문 (동적 요소)
$("pendingOrders").addEventListener("input", (e) => {
  const id = Number(e.target.dataset.id);
  if (e.target.classList.contains("ptsInput")) {
    const all = document.querySelector(`.useAll[data-id="${id}"]`);
    if (all) all.checked = false;
  }
  updateSplit(id);
});
$("pendingOrders").addEventListener("change", (e) => {
  if (!e.target.classList.contains("useAll")) return;
  const id = Number(e.target.dataset.id);
  const o = S.orders.find((x) => x.id === id);
  const input = document.querySelector(`.ptsInput[data-id="${id}"]`);
  input.value = e.target.checked ? String(S.points < o.amount ? S.points : o.amount) : "0";
  updateSplit(id);
});
$("pendingOrders").addEventListener(
  "click",
  guard(async (e) => {
    if (!e.target.classList.contains("payBtn")) return;
    const id = Number(e.target.dataset.id);
    const o = S.orders.find((x) => x.id === id);
    const raw = document.querySelector(`.ptsInput[data-id="${id}"]`).value.trim() || "0";
    if (!/^\d+$/.test(raw)) throw new Error("포인트는 0 이상의 정수로 입력해 주세요.");
    const pts = BigInt(raw);
    if (pts > o.amount) throw new Error(ERROR_KO.PointsExceedAmount);
    if (pts > S.points) throw new Error(ERROR_KO.InsufficientPoints);
    if (o.amount - pts > S.bgp) throw new Error(`BGP가 부족해요 (필요 ${fmt(o.amount - pts)}, 보유 ${fmt(S.bgp)}).`);
    await flow([[`주문 #${id} 결제 · 포인트 ${fmt(pts)} + BGP ${fmt(o.amount - pts)}`, () => bgp.pay(id, pts)]]);
  })
);

// 매장
$("createOrderBtn").addEventListener(
  "click",
  guard(async () => {
    const buyer = parseAddrInput("orderBuyer", "구매자 주소");
    const amt = parseIntInput("orderAmt", "금액");
    const min = parseIntInput("orderMin", "결제 가능 시간");
    if (min > 1440n) throw new Error("결제 가능 시간은 최대 1440분(1일)이에요.");
    await flow([[`주문 등록 · ${label(buyer)} · ${fmt(amt)}원`, () => bgp.createOrder(buyer, amt, min * 60n)]]);
  })
);

$("storeOrders").addEventListener(
  "click",
  guard(async (e) => {
    const id = Number(e.target.dataset.id);
    const o = S.orders.find((x) => x.id === id);
    if (!o) return;
    if (e.target.classList.contains("awardBtn")) {
      const reward = (o.amount * BigInt(S.myStore.rewardBps)) / 10000n;
      if (S.tkrw < reward) throw new Error(`적립 재원 tKRW가 부족해요 (필요 ${fmt(reward)}).`);
      const approve = await ensureAllowance(reward, `주문 #${id} 적립 1/2`);
      await flow([approve, [`주문 #${id} 포인트 ${fmt(reward)}점 적립`, () => bgp.awardPoints(id)]]);
    }
    if (e.target.classList.contains("refundBtn")) {
      if (!confirm(`주문 #${id}를 환불할까요?\n매장이 ${fmt(o.amount)} tKRW를 반환하고, 학생에게 BGP ${fmt(o.paidBgp)} + 포인트 ${fmt(o.paidPoints)}가 복구돼요.`)) return;
      if (S.tkrw < o.amount) throw new Error(`반환할 tKRW가 부족해요 (필요 ${fmt(o.amount)}).`);
      const approve = await ensureAllowance(o.amount, `주문 #${id} 환불 1/2`);
      await flow([approve, [`주문 #${id} 환불`, () => bgp.refund(id)]]);
    }
  })
);

// 운영자
$("addStoreBtn").addEventListener(
  "click",
  guard(async () => {
    const addr = parseAddrInput("storeAddr", "매장 주소");
    const name = $("storeName").value.trim();
    if (!name) throw new Error("매장 이름을 입력해 주세요.");
    const raw = $("storeBps").value.trim();
    if (!/^\d+$/.test(raw) || Number(raw) > 2000) throw new Error(ERROR_KO.InvalidRewardRate);
    await flow([[`매장 등록 · ${name}`, () => bgp.addStore(addr, name, Number(raw))]]);
  })
);

$("reloadEvents").addEventListener("click", loadEvents);
$("clearLog").addEventListener("click", () => {
  if (confirm("이 브라우저에 저장된 거래 기록을 지울까요? (블록체인 기록은 그대로예요)")) {
    saveLog([]);
    renderTxLog();
  }
});
$("copyLog").addEventListener("click", async () => {
  const rows = loadLog().map((r) => `| ${r.time} | ${r.title} | ${label(r.from)} | ${txUrl(r.hash)} |`);
  const md = ["| 시간 | 작업 | 보낸 계정 | 거래 |", "|---|---|---|---|", ...rows].join("\n");
  try {
    await navigator.clipboard.writeText(md);
    toast("표를 클립보드에 복사했어요.");
  } catch {
    toast("복사하지 못했어요.", { error: true });
  }
});

// 만료 카운트다운
setInterval(() => {
  document.querySelectorAll("[data-expires]").forEach((el) => {
    el.textContent = remaining({ expiresAt: Number(el.dataset.expires) });
  });
}, 1000);

// 다른 기기 / 탭에서 생긴 변화도 반영 (15초마다)
setInterval(() => {
  if (account && !S.busy) refresh();
}, 15000);

if (window.ethereum) {
  window.ethereum.on?.("accountsChanged", () => location.reload());
  window.ethereum.on?.("chainChanged", () => location.reload());
  // 이미 연결 허락한 적이 있으면 자동 연결
  window.ethereum.request({ method: "eth_accounts" }).then((accs) => accs?.length && connect()).catch(() => {});
}

renderTxLog();
setBusy(false);
