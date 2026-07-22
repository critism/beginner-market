/**
 * ============================================================
 *  discord community hub — cloudflare worker (backend + db)
 * ============================================================
 *  handles: auth verification, tickets, ticket messages,
 *  applications — all stored in a shared D1 (sqlite) database.
 *
 *  roles:
 *    - member       : anyone logged in — can open tickets & apply
 *    - staff         : can view/answer all tickets
 *    - high_staff    : staff + can review (accept/deny) applications
 *
 *  secrets / bindings are configured in wrangler.toml + dashboard.
 *  see README-cloudflare.md for the full setup.
 * ============================================================
 */

const json = (data, status = 200, origin = "*") =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    }
  });

/* verify the discord access token the browser sends, and figure out the user's role */
async function getUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.replace(/^Bearer\s+/i, "");
  if (!token) return null;

  const res = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: "Bearer " + token }
  });
  if (!res.ok) return null;
  const u = await res.json();

  const staffIds = (env.STAFF_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  const highStaffIds = (env.HIGH_STAFF_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
  const ownerIds = (env.OWNER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);

  /* hierarchy: owner > high_staff > staff > member (higher includes lower) */
  const isOwner = ownerIds.includes(u.id);
  const isHigh = isOwner || highStaffIds.includes(u.id);
  const isStaff = isHigh || staffIds.includes(u.id);
  const role = isOwner ? "owner" : (isHigh ? "high_staff" : (isStaff ? "staff" : "member"));

  const avatar = u.avatar
    ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=64`
    : `https://cdn.discordapp.com/embed/avatars/${(BigInt(u.id) >> 22n) % 6n}.png`;

  const name = u.global_name || u.username;

  /* record staff activity — upsert last_seen every time a staff member is seen */
  if (isStaff) {
    try {
      await env.DB.prepare(
        `INSERT INTO staff_activity (user_id, user_name, user_avatar, role, last_seen)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           user_name = excluded.user_name,
           user_avatar = excluded.user_avatar,
           role = excluded.role,
           last_seen = excluded.last_seen`
      ).bind(u.id, name, avatar, role, Date.now()).run();
    } catch (e) { /* activity table may not exist yet — ignore */ }
  }

  return { id: u.id, name, username: u.username, avatar, role };
}

/* role helpers — each level includes everything above it */
const isStaffRole = u => u && ["staff", "high_staff", "owner"].includes(u.role);
const isHighRole  = u => u && ["high_staff", "owner"].includes(u.role);
const isOwnerRole = u => u && u.role === "owner";

/* fire a discord webhook (server-side, so the url stays hidden) */
async function notify(env, payload) {
  if (!env.TICKET_WEBHOOK) return;
  try {
    await fetch(env.TICKET_WEBHOOK, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  } catch (e) { /* ignore webhook failures */ }
}

/* ------------------------------------------------------------
   hand out strikes for checks whose deadline has passed.
   runs lazily (whenever staff opens the panel) and via cron.
   owners are never struck.
   ------------------------------------------------------------ */
async function processExpiredChecks(env) {
  const now = Date.now();
  let due;
  try {
    due = await env.DB.prepare(
      "SELECT * FROM activity_checks WHERE processed = 0 AND deadline < ?"
    ).bind(now).all();
  } catch (e) { return; }   // table may not exist yet

  for (const check of (due.results || [])) {
    const staffIds = (env.STAFF_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
    const highIds  = (env.HIGH_STAFF_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
    const ownerIds = (env.OWNER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
    /* everyone expected to respond = staff + high staff, minus owners */
    const expected = [...new Set([...staffIds, ...highIds])].filter(id => !ownerIds.includes(id));

    const responded = await env.DB.prepare(
      "SELECT user_id FROM check_responses WHERE check_id = ?"
    ).bind(check.id).all();
    const okIds = new Set((responded.results || []).map(r => r.user_id));

    const missed = expected.filter(id => !okIds.has(id));
    const names = [];

    for (const id of missed) {
      /* try to get a readable name from the activity table */
      let name = id;
      try {
        const row = await env.DB.prepare(
          "SELECT user_name FROM staff_activity WHERE user_id = ?"
        ).bind(id).first();
        if (row?.user_name) name = row.user_name;
      } catch (e) {}
      names.push(name);
      await env.DB.prepare(
        "INSERT INTO staff_strikes (user_id, user_name, reason, check_id, created) VALUES (?, ?, ?, ?, ?)"
      ).bind(id, name, "missed activity check: " + check.title, check.id, now).run();
    }

    await env.DB.prepare("UPDATE activity_checks SET processed = 1 WHERE id = ?").bind(check.id).run();

    if (missed.length) {
      /* count totals so we can flag anyone who hit 3 */
      const flagged = [];
      for (const id of missed) {
        const c = await env.DB.prepare(
          "SELECT COUNT(*) AS c FROM staff_strikes WHERE user_id = ?"
        ).bind(id).first();
        if ((c?.c || 0) >= 3) flagged.push(`<@${id}>`);
      }
      await notify(env, {
        username: "activity check",
        embeds: [{
          title: "⚠️ activity check closed — " + check.title,
          description:
            `**${missed.length}** staff missed the deadline and received a strike:\n` +
            missed.map(id => `<@${id}>`).join(", ") +
            (flagged.length ? `\n\n🚨 **at 3+ strikes:** ${flagged.join(", ")}` : ""),
          color: 15548997,
          timestamp: new Date().toISOString()
        }]
      });
    }
  }
}

export default {
  /* cron trigger — see [triggers] in wrangler.toml */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(processExpiredChecks(env));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "");
    const origin = env.ALLOWED_ORIGIN || "*";

    /* CORS preflight — must be 204 with NO body but WITH cors headers */
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type,Authorization",
          "Access-Control-Max-Age": "86400"
        }
      });
    }

    try {
      /* -------- who am i (role check for the frontend) -------- */
      if (path === "/api/me" && request.method === "GET") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        return json({ user }, 200, origin);
      }

      /* ================= ANNOUNCEMENTS ================= */

      /* list announcements — anyone logged in can read */
      if (path === "/api/announcements" && request.method === "GET") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        const rows = await env.DB.prepare(
          "SELECT * FROM announcements ORDER BY created DESC LIMIT 50"
        ).all();
        return json({ announcements: rows.results || [] }, 200, origin);
      }

      /* create an announcement — HIGH STAFF ONLY */
      if (path === "/api/announcements" && request.method === "POST") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isHighRole(user)) return json({ error: "high staff only" }, 403, origin);

        const body = await request.json();
        const title = String(body.title || "").slice(0, 120);
        const text = String(body.body || "").slice(0, 3000);
        if (!title || !text) return json({ error: "title and body required" }, 400, origin);

        const now = Date.now();
        const r = await env.DB.prepare(
          `INSERT INTO announcements (author_id, author_name, title, body, created)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(user.id, user.name, title, text, now).run();

        await notify(env, {
          username: "announcements",
          embeds: [{
            title: "📣 " + title,
            description: text.slice(0, 2000),
            color: 3447003,
            footer: { text: "by " + user.name },
            timestamp: new Date().toISOString()
          }]
        });
        return json({ id: r.meta.last_row_id }, 200, origin);
      }

      /* delete an announcement — HIGH STAFF ONLY */
      const annMatch = path.match(/^\/api\/announcements\/(\d+)$/);
      if (annMatch && request.method === "DELETE") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isHighRole(user)) return json({ error: "high staff only" }, 403, origin);
        await env.DB.prepare("DELETE FROM announcements WHERE id = ?").bind(annMatch[1]).run();
        return json({ ok: true }, 200, origin);
      }

      /* ================= STAFF ACTIVITY ================= */

      /* who's on the team + when they were last seen — staff only */
      if (path === "/api/staff-activity" && request.method === "GET") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isStaffRole(user)) return json({ error: "staff only" }, 403, origin);
        const rows = await env.DB.prepare(
          "SELECT * FROM staff_activity ORDER BY last_seen DESC"
        ).all();
        return json({ activity: rows.results || [] }, 200, origin);
      }

      /* ================= ACTIVITY CHECKS ================= */

      /* list checks + my response state + everyone's strikes (staff only) */
      if (path === "/api/checks" && request.method === "GET") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isStaffRole(user)) return json({ error: "staff only" }, 403, origin);

        await processExpiredChecks(env);   // hand out strikes for anything overdue

        const checks = await env.DB.prepare(
          "SELECT * FROM activity_checks ORDER BY created DESC LIMIT 20"
        ).all();
        const responses = await env.DB.prepare(
          "SELECT * FROM check_responses"
        ).all();
        const strikes = await env.DB.prepare(
          `SELECT user_id, user_name, COUNT(*) AS count, MAX(created) AS last
           FROM staff_strikes GROUP BY user_id ORDER BY count DESC`
        ).all();
        return json({
          checks: checks.results || [],
          responses: responses.results || [],
          strikes: strikes.results || []
        }, 200, origin);
      }

      /* start a new check — HIGH STAFF / OWNER */
      if (path === "/api/checks" && request.method === "POST") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isHighRole(user)) return json({ error: "high staff only" }, 403, origin);

        const body = await request.json();
        const title = String(body.title || "activity check").slice(0, 120);
        const hours = Math.min(Math.max(parseInt(body.hours) || 24, 1), 168);

        const now = Date.now();
        const deadline = now + hours * 3600000;
        const r = await env.DB.prepare(
          `INSERT INTO activity_checks (created_by, created_by_name, title, created, deadline)
           VALUES (?, ?, ?, ?, ?)`
        ).bind(user.id, user.name, title, now, deadline).run();

        await notify(env, {
          username: "activity check",
          embeds: [{
            title: "🔔 " + title,
            description: `all staff must confirm within **${hours}h** on the website.\nmissing the deadline = 1 strike.`,
            color: 16766720,
            footer: { text: "started by " + user.name },
            timestamp: new Date().toISOString()
          }]
        });
        return json({ id: r.meta.last_row_id }, 200, origin);
      }

      /* confirm a check ("i'm here") — any staff */
      const chkMatch = path.match(/^\/api\/checks\/(\d+)\/respond$/);
      if (chkMatch && request.method === "POST") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isStaffRole(user)) return json({ error: "staff only" }, 403, origin);

        const id = chkMatch[1];
        const check = await env.DB.prepare("SELECT * FROM activity_checks WHERE id = ?").bind(id).first();
        if (!check) return json({ error: "not found" }, 404, origin);
        if (Date.now() > check.deadline) return json({ error: "deadline has passed" }, 400, origin);

        await env.DB.prepare(
          `INSERT INTO check_responses (check_id, user_id, user_name, responded)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(check_id, user_id) DO UPDATE SET responded = excluded.responded`
        ).bind(id, user.id, user.name, Date.now()).run();
        return json({ ok: true }, 200, origin);
      }

      /* delete a check — OWNER only */
      const chkDel = path.match(/^\/api\/checks\/(\d+)$/);
      if (chkDel && request.method === "DELETE") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isOwnerRole(user)) return json({ error: "owner only" }, 403, origin);
        await env.DB.prepare("DELETE FROM check_responses WHERE check_id = ?").bind(chkDel[1]).run();
        await env.DB.prepare("DELETE FROM activity_checks WHERE id = ?").bind(chkDel[1]).run();
        return json({ ok: true }, 200, origin);
      }

      /* ================= STRIKES ================= */

      /* clear all strikes of one staff member — OWNER only */
      const strikeMatch = path.match(/^\/api\/strikes\/(\d+)$/);
      if (strikeMatch && request.method === "DELETE") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isOwnerRole(user)) return json({ error: "owner only" }, 403, origin);
        await env.DB.prepare("DELETE FROM staff_strikes WHERE user_id = ?").bind(strikeMatch[1]).run();
        return json({ ok: true }, 200, origin);
      }

      /* manually give a strike — OWNER only */
      if (path === "/api/strikes" && request.method === "POST") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isOwnerRole(user)) return json({ error: "owner only" }, 403, origin);
        const body = await request.json();
        const targetId = String(body.userId || "");
        const targetName = String(body.userName || "unknown").slice(0, 80);
        const reason = String(body.reason || "manual strike").slice(0, 200);
        if (!targetId) return json({ error: "userId required" }, 400, origin);
        await env.DB.prepare(
          "INSERT INTO staff_strikes (user_id, user_name, reason, created) VALUES (?, ?, ?, ?)"
        ).bind(targetId, targetName, reason, Date.now()).run();
        return json({ ok: true }, 200, origin);
      }

      /* ================= STAFF CHAT ================= */

      if (path === "/api/staff-chat" && request.method === "GET") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isStaffRole(user)) return json({ error: "staff only" }, 403, origin);
        const rows = await env.DB.prepare(
          "SELECT * FROM staff_chat ORDER BY created DESC LIMIT 60"
        ).all();
        return json({ messages: (rows.results || []).reverse() }, 200, origin);
      }

      if (path === "/api/staff-chat" && request.method === "POST") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isStaffRole(user)) return json({ error: "staff only" }, 403, origin);
        const body = await request.json();
        const text = String(body.text || "").slice(0, 800);
        if (!text) return json({ error: "text required" }, 400, origin);
        await env.DB.prepare(
          `INSERT INTO staff_chat (author_id, author_name, author_avatar, role, text, created)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(user.id, user.name, user.avatar, user.role, text, Date.now()).run();
        return json({ ok: true }, 200, origin);
      }

      /* delete a staff chat message — OWNER only */
      const chatDel = path.match(/^\/api\/staff-chat\/(\d+)$/);
      if (chatDel && request.method === "DELETE") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isOwnerRole(user)) return json({ error: "owner only" }, 403, origin);
        await env.DB.prepare("DELETE FROM staff_chat WHERE id = ?").bind(chatDel[1]).run();
        return json({ ok: true }, 200, origin);
      }

      /* ================= TICKETS ================= */

      /* list my tickets, or ALL tickets if staff (?scope=all) */
      if (path === "/api/tickets" && request.method === "GET") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);

        const scope = url.searchParams.get("scope");
        let rows;
        if (scope === "all" && isStaffRole(user)) {
          rows = await env.DB.prepare(
            "SELECT * FROM tickets ORDER BY created DESC"
          ).all();
        } else {
          rows = await env.DB.prepare(
            "SELECT * FROM tickets WHERE user_id = ? ORDER BY created DESC"
          ).bind(user.id).all();
        }
        return json({ tickets: rows.results || [] }, 200, origin);
      }

      /* create a ticket */
      if (path === "/api/tickets" && request.method === "POST") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);

        const body = await request.json();
        const cat = String(body.category || "general").slice(0, 60);
        const msg = String(body.message || "").slice(0, 1500);
        if (!msg) return json({ error: "message required" }, 400, origin);

        const now = Date.now();

        /* rate limit — staff are exempt */
        if (!isStaffRole(user)) {
          const open = await env.DB.prepare(
            "SELECT COUNT(*) AS c FROM tickets WHERE user_id = ? AND status = 'open'"
          ).bind(user.id).first();
          if ((open?.c || 0) >= 3)
            return json({ error: "you already have 3 open tickets — close one first" }, 429, origin);

          const recent = await env.DB.prepare(
            "SELECT COUNT(*) AS c FROM tickets WHERE user_id = ? AND created > ?"
          ).bind(user.id, now - 3600000).first();
          if ((recent?.c || 0) >= 5)
            return json({ error: "too many tickets in the last hour — please wait a bit" }, 429, origin);
        }
        const r = await env.DB.prepare(
          `INSERT INTO tickets (user_id, user_name, user_avatar, category, message, status, created)
           VALUES (?, ?, ?, ?, ?, 'open', ?)`
        ).bind(user.id, user.name, user.avatar, cat, msg, now).run();

        const id = r.meta.last_row_id;
        await notify(env, {
          username: "tickets",
          embeds: [{
            title: "🎫 new ticket #" + id,
            color: 5793266,
            fields: [
              { name: "user", value: `<@${user.id}> (${user.name})` },
              { name: "category", value: cat },
              { name: "description", value: msg.slice(0, 1000) }
            ],
            timestamp: new Date().toISOString()
          }]
        });
        return json({ id }, 200, origin);
      }

      /* ticket detail + messages */
      const tMatch = path.match(/^\/api\/tickets\/(\d+)$/);
      if (tMatch && request.method === "GET") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        const id = tMatch[1];

        const ticket = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first();
        if (!ticket) return json({ error: "not found" }, 404, origin);
        /* only the owner or staff may read */
        const isStaff = isStaffRole(user);
        if (ticket.user_id !== user.id && !isStaff) return json({ error: "forbidden" }, 403, origin);

        const msgs = await env.DB.prepare(
          "SELECT * FROM messages WHERE ticket_id = ? ORDER BY created ASC"
        ).bind(id).all();
        return json({ ticket, messages: msgs.results || [] }, 200, origin);
      }

      /* post a message into a ticket */
      const mMatch = path.match(/^\/api\/tickets\/(\d+)\/messages$/);
      if (mMatch && request.method === "POST") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        const id = mMatch[1];

        const ticket = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first();
        if (!ticket) return json({ error: "not found" }, 404, origin);
        const isStaff = isStaffRole(user);
        if (ticket.user_id !== user.id && !isStaff) return json({ error: "forbidden" }, 403, origin);
        if (ticket.status === "closed") return json({ error: "ticket closed" }, 400, origin);

        const body = await request.json();
        const text = String(body.text || "").slice(0, 800);
        if (!text) return json({ error: "text required" }, 400, origin);

        const now = Date.now();
        await env.DB.prepare(
          `INSERT INTO messages (ticket_id, author_id, author_name, author_avatar, is_staff, text, created)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, user.id, user.name, user.avatar, isStaff ? 1 : 0, text, now).run();

        await notify(env, {
          username: "tickets",
          embeds: [{
            title: (isStaff ? "🛡️ staff reply" : "💬 reply") + " — ticket #" + id,
            color: isStaff ? 14257737 : 5793266,
            description: text.slice(0, 1500),
            footer: { text: user.name }
          }]
        });
        return json({ ok: true }, 200, origin);
      }

      /* change ticket status (owner can close; staff can close/resolve) */
      if (tMatch && request.method === "PATCH") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        const id = tMatch[1];
        const ticket = await env.DB.prepare("SELECT * FROM tickets WHERE id = ?").bind(id).first();
        if (!ticket) return json({ error: "not found" }, 404, origin);
        const isStaff = isStaffRole(user);
        if (ticket.user_id !== user.id && !isStaff) return json({ error: "forbidden" }, 403, origin);

        const body = await request.json();
        const status = body.status === "closed" ? "closed" : "open";
        await env.DB.prepare("UPDATE tickets SET status = ? WHERE id = ?").bind(status, id).run();
        return json({ ok: true }, 200, origin);
      }

      /* ================= APPLICATIONS ================= */

      /* list: my applications, or ALL if high_staff (?scope=all) */
      if (path === "/api/applications" && request.method === "GET") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);

        const scope = url.searchParams.get("scope");
        let rows;
        if (scope === "all" && isHighRole(user)) {
          rows = await env.DB.prepare("SELECT * FROM applications ORDER BY created DESC").all();
        } else {
          rows = await env.DB.prepare(
            "SELECT * FROM applications WHERE user_id = ? ORDER BY created DESC"
          ).bind(user.id).all();
        }
        return json({ applications: rows.results || [] }, 200, origin);
      }

      /* submit an application */
      if (path === "/api/applications" && request.method === "POST") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);

        const body = await request.json();
        const position = String(body.position || "").slice(0, 60);
        const age = String(body.age || "").slice(0, 6);
        const answer = String(body.answer || "").slice(0, 2000);
        if (!position || !answer) return json({ error: "missing fields" }, 400, origin);

        /* one open application per position per user */
        const existing = await env.DB.prepare(
          "SELECT id FROM applications WHERE user_id = ? AND position = ? AND status = 'pending'"
        ).bind(user.id, position).first();
        if (existing) return json({ error: "you already have a pending application for this position" }, 400, origin);

        const now = Date.now();
        const r = await env.DB.prepare(
          `INSERT INTO applications (user_id, user_name, user_avatar, position, age, answer, status, created)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
        ).bind(user.id, user.name, user.avatar, position, age, answer, now).run();

        await notify(env, {
          username: "applications",
          embeds: [{
            title: "📋 new " + position + " application",
            color: 16766720,
            fields: [
              { name: "user", value: `<@${user.id}> (${user.name})` },
              { name: "age", value: age || "—" },
              { name: "answer", value: answer.slice(0, 1000) }
            ],
            timestamp: new Date().toISOString()
          }]
        });
        return json({ id: r.meta.last_row_id }, 200, origin);
      }

      /* review an application — HIGH STAFF ONLY */
      const aMatch = path.match(/^\/api\/applications\/(\d+)$/);
      if (aMatch && request.method === "PATCH") {
        const user = await getUser(request, env);
        if (!user) return json({ error: "unauthorized" }, 401, origin);
        if (!isHighRole(user)) return json({ error: "high staff only" }, 403, origin);

        const id = aMatch[1];
        const body = await request.json();
        const decision = ["accepted", "denied"].includes(body.status) ? body.status : null;
        if (!decision) return json({ error: "invalid status" }, 400, origin);
        const note = String(body.note || "").slice(0, 500);

        const app = await env.DB.prepare("SELECT * FROM applications WHERE id = ?").bind(id).first();
        if (!app) return json({ error: "not found" }, 404, origin);

        await env.DB.prepare(
          "UPDATE applications SET status = ?, review_note = ?, reviewed_by = ? WHERE id = ?"
        ).bind(decision, note, user.name, id).run();

        await notify(env, {
          username: "applications",
          embeds: [{
            title: (decision === "accepted" ? "✅" : "❌") + " " + app.position + " application " + decision,
            color: decision === "accepted" ? 5763719 : 15548997,
            fields: [
              { name: "applicant", value: `<@${app.user_id}> (${app.user_name})` },
              { name: "reviewed by", value: user.name },
              ...(note ? [{ name: "note", value: note }] : [])
            ],
            timestamp: new Date().toISOString()
          }]
        });
        return json({ ok: true }, 200, origin);
      }

      return json({ error: "not found" }, 404, origin);
    } catch (e) {
      return json({ error: "server error", detail: String(e) }, 500, origin);
    }
  }
};
