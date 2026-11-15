const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type, X-Owner-Secret"
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
});
const clean = (v, n=500) => String(v ?? "").trim().slice(0,n);
const owner = (request, env) => !!env.OWNER_SECRET &&
  request.headers.get("X-Owner-Secret") === env.OWNER_SECRET;
async function adminApi(request, env, url) {
  if (!env.DB) return json({error:"قاعدة البيانات غير مربوطة"},503);
  if (!owner(request,env)) return json({error:"غير مصرح — تحقق من كلمة سر المالك"},401);
  if (request.method !== "POST") return json({error:"Method not allowed"},405);
  const b = await request.json();
  if (url.pathname === "/admin/overview") {
    const [users,reports,pending,agents] = await Promise.all([
      env.DB.prepare("SELECT COUNT(*) AS n FROM users").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM reports").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM reports WHERE status='new'").first(),
      env.DB.prepare("SELECT COUNT(*) AS n FROM agent_codes").first()
    ]);
    return json({ok:true,stats:{users:users.n,reports:reports.n,newReports:pending.n,agentCodes:agents.n}});
  }
  if (url.pathname === "/admin/users") {
    const q=clean(b.query,100);
    const rows=q
      ? await env.DB.prepare("SELECT * FROM users WHERE id LIKE ? OR name LIKE ? ORDER BY created_at DESC LIMIT 100").bind("%"+q+"%","%"+q+"%").all()
      : await env.DB.prepare("SELECT * FROM users ORDER BY created_at DESC LIMIT 100").all();
    return json({ok:true,users:rows.results||[]});
  }
  if (url.pathname === "/admin/reports") {
    const rows=await env.DB.prepare("SELECT * FROM reports ORDER BY CASE status WHEN 'new' THEN 0 ELSE 1 END, created_at DESC LIMIT 200").all();
    return json({ok:true,reports:rows.results||[]});
  }
  if (url.pathname === "/admin/user-action") {
    const id=clean(b.id,100), action=clean(b.action,20);
    if(!id) return json({error:"مطلوب ID المستخدم"},400);
    const user=await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
    if(!user) return json({error:"المستخدم غير موجود"},404);
    if(action==="credit"||action==="debit"){
      const amount=Math.floor(Number(b.amount));
      if(!Number.isSafeInteger(amount)||amount<1||amount>100000000) return json({error:"قيمة النقاط غير صالحة"},400);
      const delta=action==="credit"?amount:-amount;
      await env.DB.prepare("UPDATE users SET balance=MAX(0,balance+?) WHERE id=?").bind(delta,id).run();
    } else if(action==="warn") {
      await env.DB.prepare("UPDATE users SET warnings=warnings+1 WHERE id=?").bind(id).run();
    } else if(action==="ban"||action==="close") {
      const col=action==="ban"?"banned":"closed";
      await env.DB.prepare("UPDATE users SET "+col+"=CASE "+col+" WHEN 1 THEN 0 ELSE 1 END WHERE id=?").bind(id).run();
    } else if(action==="lookup") {
      return json({ok:true,user});
    } else return json({error:"عملية غير معروفة"},400);
    const updated=await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
    return json({ok:true,user:updated});
  }
  if (url.pathname === "/admin/report-status") {
    const id=Number(b.id), status=clean(b.status,20);
    if(!Number.isSafeInteger(id)||!["new","reviewed","resolved"].includes(status)) return json({error:"بيانات البلاغ غير صالحة"},400);
    await env.DB.prepare("UPDATE reports SET status=? WHERE id=?").bind(status,id).run();
    return json({ok:true});
  }
  return json({error:"Unknown admin endpoint"},404);
}

async function paymentApi(request, env, url) {
  if (!env.DB || !env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OWNER_CHAT_ID) return json({error:"إعدادات الدفع غير مكتملة"},503);
  if (url.pathname === "/payments/submit") {
    if (request.method !== "POST") return json({error:"Method not allowed"},405);
    try {
      const form = await request.formData();
      const userId = clean(form.get("userId"),100);
      const userName = clean(form.get("userName"),80);
      const method = clean(form.get("method"),20);
      const senderPhone = clean(form.get("senderPhone"),30);
      const transactionId = clean(form.get("transactionId"),100);
      const coins = Math.floor(Number(form.get("coins")));
      const amount = Number(form.get("amount"));
      const photo = form.get("receipt");
      if (!userId || !["vodafone","etisalat"].includes(method) || !/^01[0-25][0-9]{8}$/.test(senderPhone) ||
          !Number.isSafeInteger(coins) || coins < 100 || coins % 100 || amount !== coins/5 ||
          !(photo instanceof File) || !photo.type.startsWith("image/") || photo.size > 5*1024*1024) {
        return json({error:"راجع البيانات والصورة (الحد الأقصى 5 ميجابايت)"},400);
      }
      const user = await env.DB.prepare("SELECT id,name FROM users WHERE id=?").bind(userId).first();
      if (!user) return json({error:"الحساب غير مسجل على السيرفر"},404);
      const id = crypto.randomUUID();
      const token = crypto.randomUUID()+crypto.randomUUID();
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS payment_orders (id TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL, user_id TEXT NOT NULL, user_name TEXT, method TEXT NOT NULL, sender_phone TEXT NOT NULL, transaction_id TEXT, coins INTEGER NOT NULL, amount REAL NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
      await env.DB.prepare("INSERT INTO payment_orders (id,token,user_id,user_name,method,sender_phone,transaction_id,coins,amount) VALUES (?,?,?,?,?,?,?,?,?)")
        .bind(id,token,userId,userName||user.name,method,senderPhone,transactionId,coins,amount).run();
      const caption = "طلب شحن جديد 🧾\nرقم الطلب: "+id+"\nالاسم: "+(userName||user.name)+"\nUser ID: "+userId+"\nالطريقة: "+(method==="vodafone"?"فودافون كاش":"اتصالات كاش")+"\nرقم المرسل: "+senderPhone+"\nالمبلغ: "+amount+" جنيه\nالعملات: "+coins+"\nرقم العملية: "+(transactionId||"غير مضاف");
      const kb = {inline_keyboard:[[
        {text:"✅ موافقة وإضافة الرصيد",url:url.origin+"/payments/review?token="+token+"&action=approve"},
        {text:"❌ رفض الطلب",url:url.origin+"/payments/review?token="+token+"&action=reject"}
      ]]};
      const fd = new FormData();
      fd.set("chat_id",env.TELEGRAM_OWNER_CHAT_ID);
      fd.set("photo",photo,photo.name||"receipt.jpg");
      fd.set("caption",caption);
      fd.set("reply_markup",JSON.stringify(kb));
      const tg = await fetch("https://api.telegram.org/bot"+env.TELEGRAM_BOT_TOKEN+"/sendPhoto",{method:"POST",body:fd});
      const tgData = await tg.json();
      if (!tg.ok || !tgData.ok) {
        await env.DB.prepare("DELETE FROM payment_orders WHERE id=?").bind(id).run();
        return json({error:"تعذر إرسال الطلب للبوت. تأكد أنك ضغطت Start في البوت وأن الإعدادات صحيحة."},502);
      }
      return json({ok:true,message:"تم إرسال طلبك للمالك للمراجعة."},201);
    } catch(e) { return json({error:"تعذر إرسال طلب الدفع"},500); }
  }
  if (url.pathname === "/payments/review") {
    if (request.method !== "GET") return json({error:"Method not allowed"},405);
    const token=clean(url.searchParams.get("token"),100), action=clean(url.searchParams.get("action"),10);
    if (!token || !["approve","reject"].includes(action)) return new Response("طلب غير صالح",{status:400});
    const order=await env.DB.prepare("SELECT * FROM payment_orders WHERE token=?").bind(token).first();
    if (!order) return new Response("الطلب غير موجود",{status:404});
    if (order.status !== "pending") return new Response("تم التعامل مع الطلب بالفعل: "+order.status,{headers:{"Content-Type":"text/plain; charset=utf-8"}});
    if (action==="approve") {
      const changed=await env.DB.prepare("UPDATE payment_orders SET status='approved' WHERE id=? AND status='pending'").bind(order.id).run();
      if (!changed.meta || changed.meta.changes!==1) return new Response("تم التعامل مع الطلب بالفعل");
      const credit=await env.DB.prepare("UPDATE users SET balance=balance+? WHERE id=?").bind(order.coins,order.user_id).run();
      if (!credit.meta || credit.meta.changes!==1) {
        await env.DB.prepare("UPDATE payment_orders SET status='pending' WHERE id=? AND status='approved'").bind(order.id).run();
        return new Response("تعذر إضافة الرصيد؛ لم يتم اعتماد الطلب");
      }
    } else {
      await env.DB.prepare("UPDATE payment_orders SET status='rejected' WHERE id=? AND status='pending'").bind(order.id).run();
    }
    const label=action==="approve"?"تمت الموافقة وإضافة "+order.coins+" عملة للحساب.":"تم رفض طلب الدفع.";
    return new Response("<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width'><title>مراجعة الدفع</title><body style='font-family:Arial;background:#111;color:#fff;text-align:center;padding:40px'><h2>"+label+"</h2><p>يمكنك إغلاق الصفحة والعودة إلى تيليجرام.</p></body>",{headers:{"Content-Type":"text/html; charset=utf-8"}});
  }
  return json({error:"Not found"},404);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname.startsWith("/payments/")) { try { return await paymentApi(request, env, url); } catch (error) { return json({error:"تعذر تنفيذ طلب الدفع"},500); } }
    if (url.pathname.startsWith("/admin/")) {
      try { return await adminApi(request, env, url); } catch (error) { return json({error:"تعذر تنفيذ عملية الإدارة"},500); }
    }
    if (url.pathname === "/users/register") {
      if (request.method !== "POST") return json({error:"Method not allowed"},405);
      if (!env.DB) return json({error:"قاعدة البيانات غير مربوطة"},503);
      try {
        const b=await request.json(), id=clean(b.id,100), name=clean(b.name,40), promo=clean(b.promoCode,7).toUpperCase();
        if(!id||!name) return json({error:"الاسم والـ ID مطلوبان"},400);
        const existing=await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
        if(existing) return json({ok:true,user:existing,existing:true});
        await env.DB.prepare("INSERT INTO users (id,name,balance,promo_code,referred_by) VALUES (?,?,3,?,?)").bind(id,name,clean(b.promoCode,7)||null,null).run();
        const user=await env.DB.prepare("SELECT * FROM users WHERE id=?").bind(id).first();
        return json({ok:true,user},201);
      } catch(error) { return json({error:"تعذر تسجيل المستخدم"},500); }
    }
    if (url.pathname === "/reports/create") {
      if (request.method !== "POST") return json({error:"Method not allowed"},405);
      if (!env.DB) return json({error:"قاعدة البيانات غير مربوطة"},503);
      try { const b=await request.json(), id=clean(b.fromId,100), name=clean(b.fromName,40), message=clean(b.message,2000); if(!id||!message)return json({error:"بيانات البلاغ ناقصة"},400); const r=await env.DB.prepare("INSERT INTO reports (from_id,from_name,message) VALUES (?,?,?)").bind(id,name||"مستخدم",message).run(); return json({ok:true,id:r.meta?.last_row_id||null},201); } catch(error){return json({error:"تعذر حفظ البلاغ"},500)}
    }
    if (url.pathname === "/gift/redeem") {
      if (request.method !== "POST") return json({error:"Method not allowed"},405);
      if (!env.DB) return json({error:"قاعدة البيانات غير مربوطة"},503);
      try {
        const b=await request.json(), code=String(b.code||"").trim(), userId=clean(b.userId,100);
        if(!/^\d{19}$/.test(code)||!userId) return json({error:"الكود أو الحساب غير صالح"},400);
        await env.DB.prepare("CREATE TABLE IF NOT EXISTS gift_codes (code TEXT PRIMARY KEY, reward INTEGER NOT NULL, redeemed_by TEXT, redeemed_at TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)").run();
        await env.DB.prepare("INSERT OR IGNORE INTO gift_codes (code,reward) VALUES (?,1000)").bind("1270235249330301845").run();
        const claim=await env.DB.prepare("UPDATE gift_codes SET redeemed_by=?, redeemed_at=CURRENT_TIMESTAMP WHERE code=? AND redeemed_at IS NULL").bind(userId,code).run();
        if(!claim.meta||claim.meta.changes!==1) return json({error:"الكود غير صحيح أو تم استخدامه بالفعل"},409);
        const gift=await env.DB.prepare("SELECT reward FROM gift_codes WHERE code=?").bind(code).first();
        return json({ok:true,reward:gift.reward});
      } catch(e) { return json({error:"تعذر تفعيل كود الهدية"},500); }
    }
    if (url.pathname.startsWith("/agent/")) {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (!env.DB) return json({ error: "قاعدة الأكواد المشتركة غير مربوطة بالسيرفر" }, 503);
      try {
        const body = await request.json();
        const code = String(body.code || "").trim();
        if (!/^\d{22}$/.test(code)) return json({ error: "الكود لازم يتكون من 22 رقمًا" }, 400);
        if (url.pathname === "/agent/register") {
          const expiresAt = Number(body.expiresAt);
          if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) return json({ error: "تاريخ انتهاء البطاقة غير صالح" }, 400);
          await env.DB.prepare("INSERT OR IGNORE INTO agent_codes (code, expires_at, created_at) VALUES (?, ?, ?)").bind(code, expiresAt, Date.now()).run();
          const row = await env.DB.prepare("SELECT code FROM agent_codes WHERE code = ?").bind(code).first();
          return json({ ok: !!row });
        }
        if (url.pathname === "/agent/redeem") {
          const userId = String(body.userId || "guest").slice(0, 100);
          const result = await env.DB.prepare("UPDATE agent_codes SET redeemed_at = ?, redeemed_by = ? WHERE code = ? AND expires_at > ? AND redeemed_at IS NULL").bind(Date.now(), userId, code, Date.now()).run();
          if (!result.meta || result.meta.changes !== 1) return json({ error: "الكود غير موجود أو منتهي أو تم استخدامه بالفعل" }, 409);
          return json({ ok: true, message: "تم التفعيل مرة واحدة" });
        }
        return json({ error: "Unknown agent endpoint" }, 404);
      } catch (error) {
        return json({ error: "تعذر تنفيذ العملية على قاعدة الأكواد" }, 500);
      }
    }
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    if (request.method === "GET") return json({ ok: true, name: "Lina AI", status: "ready" });
    if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (!env.OPENAI_API_KEY) return json({ error: "مفتاح الذكاء الاصطناعي مش متضاف في Secrets" }, 500);

    try {
      const body = await request.json();
      const message = String(body.message || "").trim().slice(0, 6000);
      if (!message) return json({ error: "اكتب رسالة الأول" }, 400);

      const history = Array.isArray(body.history) ? body.history.slice(-12).map(item => ({
        role: item.role === "assistant" ? "assistant" : "user",
        content: String(item.content || "").slice(0, 3000)
      })) : [];

      const result = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + env.OPENAI_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          instructions: body.mode === "hacker" ? `أنت بوت هكر تعليمي يتحدث باللهجة المصرية. اسمك بوت هكر. تخصصك الأمن السيبراني الدفاعي والاختبار الأخلاقي المصرح به: شرح أساسيات الشبكات، حماية الحسابات والأجهزة، اكتشاف التصيد، تحليل الروابط بشكل آمن، ومبادئ اختبار الاختراق داخل مختبرات يملكها المستخدم أو لديه إذن صريح لاختبارها. لا تقدم تعليمات عملية لاختراق حسابات أو أجهزة أو شبكات الآخرين، أو سرقة كلمات المرور والجلسات، أو نشر البرمجيات الخبيثة، أو تجاوز الحماية، أو التخفي بعد الاختراق. عند الطلبات الضارة ارفض باختصار ووجّه المستخدم إلى بديل دفاعي آمن. لا تطلب كلمات مرور أو مفاتيح سرية أو بيانات دفع. اشرح خطوة بخطوة عندما يكون ذلك آمنًا، ولا تختلق معلومات.` : `أنتِ لينا، مساعدة ذكاء اصطناعي ودودة تتحدث باللهجة المصرية الطبيعية.
اسمك لينا، وشخصيتك مرحة وحنونة وذكية ومتزنة. كوني طبيعية وغير متكلفة، واستخدمي الإيموجي باعتدال.
افهمي سياق المحادثة واربطي كلامك بالرسائل السابقة. لا تكرري نفس الردود المحفوظة، ولا تستخدمي ردًا عامًا إذا كان السؤال محددًا.
أجيبي بوضوح وباختصار مناسب، واشرحي خطوة بخطوة عندما يطلب المستخدم ذلك. إذا لم تعرفي معلومة فقولي بصراحة إنك غير متأكدة ولا تختلقي حقائق.
لا تدّعي أنك إنسانة حقيقية أو أنك ترين أو تسمعين ملفات لم يتم إرسال محتواها لك.
مالكك وصاحب فكرتك هو يوسف. إذا سُئلتِ: مين مالكك؟ أو مين صاحبك؟ فقولي: يوسف. وإذا سُئلتِ من صنعك فقولي: يوسف هو اللي صنعني. لا تذكري اسم يوسف الكامل إلا إذا طُلب منك صراحة.
احترمي خصوصية المستخدم ولا تطلبي كلمات مرور أو مفاتيح سرية أو بيانات دفع.`,
          input: [...history, { role: "user", content: message }],
          max_output_tokens: 800
        })
      });

      const data = await result.json();
      if (!result.ok) {
        return json({ error: data.error?.message || "خدمة الذكاء الاصطناعي رفضت الطلب" }, result.status);
      }

      const reply = (data.output || [])
        .filter(item => item.type === "message")
        .flatMap(item => item.content || [])
        .filter(item => item.type === "output_text")
        .map(item => item.text)
        .join("\n");

      return json({ reply: reply || "مش قادرة أجهز الرد دلوقتي، جرّب تاني ❤️" });
    } catch (error) {
      return json({ error: "حصل خطأ في السيرفر. جرّب تاني بعد شوية." }, 500);
    }
  }
};
