import { issueToken } from './_session.js';

export default function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  const { password } = req.body;

  if (!password) {
    return res.status(400).json({ error: "No password provided" });
  }

  let tier = null;
  if (password === process.env.PASSWORD_ADMIN) tier = "admin";
  else if (password === process.env.PASSWORD_RESEARCH) tier = "research";
  else if (password === process.env.PASSWORD_READONLY) tier = "readonly";

  if (!tier) {
    return res.status(401).json({ error: "Incorrect password" });
  }

  return res.status(200).json({ tier, token: issueToken(tier) });
}
