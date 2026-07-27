// 動作確認用の最小構成。外部パッケージに一切依存しない。
// これが動けば「デプロイの土台」は正常 → 問題は adm-zip / papaparse 側と特定できる。

module.exports = async function handler(req, res) {
  res.status(200).json({ ok: true, message: "サーバーレス関数は正常に動いています" });
};
