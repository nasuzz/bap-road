// Hardhat 컴파일 결과에서 ABI를 꺼내 web/abi.js로 저장해요.
// 실행: npx hardhat compile && node scripts/export-abi.js
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, "artifacts/contracts", p), "utf8")).abi;

const out =
  "// 자동 생성 파일 (scripts/export-abi.js). 직접 수정하지 마세요.\n" +
  `export const BABGIL_ABI = ${JSON.stringify(read("BabgilPoint.sol/BabgilPoint.json"))};\n` +
  `export const TKRW_ABI = ${JSON.stringify(read("TKRW.sol/TKRW.json"))};\n`;

fs.writeFileSync(path.join(root, "web/abi.js"), out);
console.log("web/abi.js 생성 완료");
