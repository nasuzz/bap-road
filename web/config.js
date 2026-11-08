// 배포한 컨트랙트 주소를 여기에 넣어요.
export const CONFIG = {
  chainId: 11155111, // Sepolia
  chainName: "Sepolia",
  explorer: "https://sepolia.etherscan.io",

  tkrw: "0x0000000000000000000000000000000000000000", // TKRW 주소
  babgil: "0x0000000000000000000000000000000000000000", // BabgilPoint 주소

  // 거래 내역을 이 블록부터 읽어요 (BabgilPoint 배포 블록). 모르면 0
  deployBlock: 0,

  // (선택) 주소 옆에 보여줄 이름. 매장 이름은 컨트랙트에서 자동으로 읽어요.
  labels: {
    // "0x...": "학생",
  },
};
