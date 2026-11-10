const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
  "Access-Control-Allow-Headers": "Content-Type"
};

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: { ...cors, "Content-Type": "application/json; charset=utf-8" }
});

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });
    const url = new URL(request.url);
    if (url.pathname.startsWith("/agent/")) {
      if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);
      if (!env.DB) return json({ error: "قاعدة الأكواد المشتركة غير مربوطة بالسيرفر" }, 503);
      try {
        const body = await request.json();
        const code = String(body.code || "").trim();
        if (!/^\\d{22}$/.test(code)) return json({ error: "الكود لازم يتكون من 22 رقمًا" }, 400);
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
