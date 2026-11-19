// 배포한 컨트랙트 주소를 여기에 넣어요.
export const CONFIG = {
  chainId: 11155111, // Sepolia
  chainName: "Sepolia",
  explorer: "https://sepolia.etherscan.io",
  // 지갑 없이도 현황을 읽을 공개 RPC
  rpcUrl: "https://ethereum-sepolia-rpc.publicnode.com",

  tkrw: "0x8645F7b1465DC39186209b57162c7F14BF0a24b3", // TKRW
  babgil: "0xe8eA5d7F25dbf1651e75eB6FC9AEa741eeCc5538", // BabgilPoint (메뉴 주문 버전)

  // 거래 내역을 이 블록부터 읽어요 (BabgilPoint 배포 블록)
  deployBlock: 12167045,

  // 주소 옆에 보여줄 이름. 매장 이름은 컨트랙트에서 자동으로 읽어요.
  // 메뉴 사진: 매장 주소 → { "메뉴 이름(컨트랙트에 등록한 이름과 똑같이)": "사진 경로" }
  menuImages: {
    "0x142DAEb09bdC4de45bC64835002AA11E4C5bD85A": { // 신의한컵
      "제육알밥": "img/menu/shinui-jeyuk-albap.jpg",
      "김치고기마요": "img/menu/shinui-kimchi-gogi-mayo.jpg",
    },
    "0x57421a5176a04cD4b16884D0350a11D243E76375": { // 리플커피
      "아메리카노": "img/menu/ripple-americano.jpg",
      "아이스아메리카노": "img/menu/ripple-americano.jpg",
      "아샷추": "img/menu/ripple-ashotchu.jpg",
    },
  },

  labels: {
    "0x9275a30A72E0d3DA391e2956aA9b778f5117c8C6": "운영자",
  },
};
