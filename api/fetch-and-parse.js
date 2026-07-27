const { fetchTodayData } = require("../lib/nar-data.js");

module.exports = async function handler(req, res) {
  try {
    const data = await fetchTodayData();
    res.status(200).json(data);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message, stack: err.stack });
  }
};
