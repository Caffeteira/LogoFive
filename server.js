import express from "express";
import dotenv from "dotenv";
import Stripe from "stripe";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${port}`;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

app.set("view engine", "ejs");
app.use(express.static("public"));
app.use(express.json({ limit: "2mb" }));

/**
 * “Banco” simples em memória:
 * paidTokens guarda tokens liberados após webhook confirmar pagamento.
 * Em produção: use um banco (SQLite/Postgres/Redis).
 */
const paidTokens = new Set();

/** Gera um token simples (para demo) */
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

/**
 * Cria Checkout Session de R$ 5,00 e redireciona
 */
app.post("/pagar", async (req, res) => {
  try {
    // um token que será liberado ao confirmar pagamento
    const token = makeToken();

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          price_data: {
            currency: "brl",
            unit_amount: 500, // R$ 5,00 em centavos
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
      metadata: {
        token
      }
    });

    res.json({ url: session.url });
  } catch (e) {
    res.status(500).json({ error: "Erro ao criar pagamento", details: String(e) });
  }
});

/**
 * Página de sucesso: mostra botão “Ir para criar”,
 * mas a liberação real vem do webhook (mais seguro).
 */
app.get("/sucesso", async (req, res) => {
  res.render("sucesso");
});

app.get("/cancelado", (req, res) => {
  res.render("cancelado");
});

/**
 * Página de criação: precisa de token liberado
 */
app.get("/criar", (req, res) => {
  const token = req.query.token;
  const ok = token && paidTokens.has(token);

  if (!ok) {
    return res.status(403).send("Acesso negado. Pague R$ 5 para liberar a criação.");
  }
  res.render("criar", { token });
});

/**
 * Endpoint de geração (só aceita se token estiver pago)
 * Aqui você chama a API de imagens (OpenAI) para gerar a logo.
 */
app.post("/api/generate", async (req, res) => {
  try {
    const { token, prompt } = req.body;

    if (!token || !paidTokens.has(token)) {
      return res.status(403).json({ error: "Pagamento não confirmado." });
    }
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Prompt inválido." });
    }

    // Evita usar marcas/IPs diretamente (mantém mais seguro)
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

    // Chamada à OpenAI Images
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
    res.status(500).json({ error: "Erro interno.", details: String(e) });
  }
});

/**
 * Webhook do Stripe: confirma pagamento e libera o token.
 * IMPORTANTE: webhook usa raw body.
 */
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;

  try {
    const sig = req.headers["stripe-signature"];
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    const session = event.data.object;
    const token = session?.metadata?.token;
    if (token) paidTokens.add(token);
  }

  res.json({ received: true });
});

app.listen(port, () => {
  console.log(`Rodando em ${BASE_URL}`);
  console.log(`Webhook em ${BASE_URL}/webhook`);
});
