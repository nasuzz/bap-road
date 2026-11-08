// 배포한 컨트랙트 주소를 여기에 넣어요.
export const CONFIG = {
  chainId: 11155111, // Sepolia
  chainName: "Sepolia",
  explorer: "https://sepolia.etherscan.io",

  tkrw: "0x8645F7b1465DC39186209b57162c7F14BF0a24b3", // TKRW
  babgil: "0x4204a19535B63c95B6E635f9525C21A36C42714E", // BabgilPoint

  // 거래 내역을 이 블록부터 읽어요 (BabgilPoint 배포 블록)
  deployBlock: 12088451,

  // 주소 옆에 보여줄 이름. 매장 이름은 컨트랙트에서 자동으로 읽어요.
  labels: {
    "0x9275a30A72E0d3DA391e2956aA9b778f5117c8C6": "운영자",
    "0xB56f978082d29D0A722cCA7894fA181dB51Eca25": "학생",
  },
};
