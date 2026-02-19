import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// No Render, BASE_URL deve ser tipo: https://seusite.onrender.com
const BASE_URL = process.env.BASE_URL || `https://logofive.onrender.com:${port}`;

// Validar envs essenciais (evita crash silencioso)
if (!process.env.STRIPE_SECRET_KEY) {
  console.error("Faltou STRIPE_SECRET_KEY nas variáveis de ambiente.");
}
if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.error("Faltou STRIPE_WEBHOOK_SECRET nas variáveis de ambiente.");
}
if (!process.env.OPENAI_API_KEY) {
  console.error("Faltou OPENAI_API_KEY nas variáveis de ambiente.");
}

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.set("view engine", "ejs");

// ✅ WEBHOOK PRECISA VIR ANTES DO express.json()
// Use raw body só nesta rota:
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;

  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(
      req.body, // <- Buffer raw
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error("Webhook signature error:", err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const token = session?.metadata?.token;
    if (token) paidTokens.add(token);
  }

  res.json({ received: true });
});

// Agora sim: middlewares normais
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true })); // ✅ para form POST
app.use(express.json({ limit: "2mb" }));         // ✅ para requests JSON

/**
 * “Banco” simples em memória:
 * Em produção, use banco de dados.
 */
const paidTokens = new Set();

function makeToken() {
  return cryptoRandomString(32);
}
function cryptoRandomString(len) {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

app.get("/", (req, res) => {
  res.render("home");
});

app.post("/pagar", async (req, res) => {
  try {
    const token = makeToken();

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "brl",
            unit_amount: 500,
            product_data: {
              name: "Geração de Logotipo (1x)",
              description: "Libera 1 geração de logo no site"
            }
          },
          quantity: 1
        }
      ],
      success_url: `${BASE_URL}/sucesso?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/cancelado`,
      metadata: { token }
    });

    // Se sua home usa fetch, isso funciona.
    // Se usa form normal, você pode fazer res.redirect(session.url) também.
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro ao criar pagamento", details: String(e) });
  }
});

app.get("/sucesso", (req, res) => {
  res.render("sucesso");
});

app.get("/cancelado", (req, res) => {
  res.render("cancelado");
});

app.get("/criar", (req, res) => {
  const token = req.query.token;
  const ok = token && paidTokens.has(token);

  if (!ok) return res.status(403).send("Acesso negado. Pague R$ 5 para liberar a criação.");

  res.render("criar", { token });
});

app.post("/api/generate", async (req, res) => {
  try {
    const { token, prompt } = req.body;

    if (!token || !paidTokens.has(token)) {
      return res.status(403).json({ error: "Pagamento não confirmado." });
    }
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Prompt inválido." });
    }

    const safePrompt = prompt.replace(/minecraft|skywars/gi, "pixel fantasy").trim();

    const finalPrompt = `
Crie um ícone de app (logo) para um jogo RPG de aventura.
Estilo: detalhado, dramático, alto contraste, ícone central, visual premium.
Elementos: ${safePrompt}.
Fundo: cor chapada (flat), sem textura, sem papel, sem mockup.
Sem texto, sem letras, sem marca d'água.
Formato: app icon, cantos arredondados.
Paleta: azul meia-noite, cinza aço, laranja fogo.
`.trim();

    const resp = await fetch("https://api.openai.com/v1/images/generations", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "gpt-image-1",
        prompt: finalPrompt,
        size: "1024x1024"
      })
    });

    if (!resp.ok) {
      const text = await resp.text();
      return res.status(500).json({ error: "Falha ao gerar imagem.", details: text });
    }

    const data = await resp.json();
    const b64 = data?.data?.[0]?.b64_json;
    const url = data?.data?.[0]?.url;

    // Consome o token (1 geração por pagamento)
    paidTokens.delete(token);

    if (b64) return res.json({ image: `data:image/png;base64,${b64}` });
    if (url) return res.json({ image: url });

    return res.status(500).json({ error: "Resposta inesperada da API." });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Erro interno.", details: String(e) });
  }
});

app.listen(port, () => {
  console.log(`Rodando em ${BASE_URL}`);
  console.log(`Webhook em ${BASE_URL}/webhook`);
});

