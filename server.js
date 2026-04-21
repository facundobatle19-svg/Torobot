import { MongoClient } from "mongodb";
import 'dotenv/config';
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import Groq from "groq-sdk";
import { Readable } from "stream";
import { promptInmobiliaria } from "./prompts/inmobiliaria.js";

// ==========================================
// 🌐 CONFIG PUPPETEER (MÁXIMO AHORRO)
// ==========================================
function getPuppeteerConfig() {
  const isRender = process.env.RENDER === "true";

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // Crítico para Docker/Render
    '--disable-gpu',
    '--no-zygote',
    '--single-process', // Ahorra muchísima RAM al no abrir múltiples procesos
    '--disable-extensions',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--js-flags="--max-old-space-size=256"', // Limita la RAM de V8 dentro de Chrome
  ];

  if (isRender) {
    // Usamos una ruta fija pero limpia para no llenar el disco de perfiles temporales
    return {
      headless: true,
      args: [...args, '--user-data-dir=/var/data/chrome-profile']
    };
  }

  return {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };
}

// 🔌 MongoDB con Pool pequeño
const clientDB = new MongoClient(process.env.MONGO_URI, {
  maxPoolSize: 2, // No necesitamos más conexiones, ahorra memoria de red
  serverSelectionTimeoutMS: 5000
});
await clientDB.connect();
const db = clientDB.db("coworking");
const reservas = db.collection("reservas");
const conversaciones = db.collection("conversaciones");

// 🤖 IA
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// [Mantenemos parsearFechaTurno igual pero optimizamos el flujo de datos]

function crearCliente(nombre, promptPersonalizado) {
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: nombre,
      dataPath: process.env.RENDER ? `/var/data/.wwebjs_auth/${nombre}` : `./.wwebjs_auth/${nombre}`
    }),
    // Forzamos una versión de web liviana y remota para no saturar el inicio
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: getPuppeteerConfig()
  });

  client.on("qr", (qr) => qrcode.generate(qr, { small: true }));

  client.on("message", async (message) => {
    // 1. Filtrado inmediato: No procesar nada innecesario
    if (message.fromMe || message.from.includes("@g.us") || message.from === 'status@broadcast') return;

    try {
      let texto = message.body || "";

      // 2. Audio: Solo descargar si es estrictamente necesario
      if (message.hasMedia && (message.type === 'audio' || message.type === 'ptt')) {
        const media = await message.downloadMedia();
        if (media) {
          const buffer = Buffer.from(media.data, 'base64');
          const transcription = await groq.audio.transcriptions.create({
            file: Readable.from(buffer),
            model: "whisper-large-v3",
            language: "es",
          });
          texto = transcription.text;
        }
      }

      if (!texto || texto.trim() === "") return;
      const textoLower = texto.toLowerCase().trim();

      // 3. Proyección en DB: Solo traemos los campos que vamos a usar
      let conv = await conversaciones.findOne(
        { telefono: message.from, botId: nombre },
        { projection: { estado: 1, historial: 1, fechaTurnoTemp: 1 } }
      );

      if (!conv) {
        conv = { telefono: message.from, estado: "inicio", botId: nombre, historial: [] };
        await conversaciones.insertOne(conv);
        // ... (Lógica de saludo inicial)
      }

      // [Lógica de estados igual...]

      // 4. Memoria IA: Reducimos a los últimos 6 mensajes (suficiente para contexto)
      const completion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: promptPersonalizado },
          ...conv.historial.slice(-6), 
          { role: "user", content: texto }
        ],
        model: "llama-3.1-8b-instant"
      });

      const respuestaIA = completion.choices[0].message.content;

      // 5. Historial: Solo guardamos los últimos 10 mensajes en la DB
      await conversaciones.updateOne(
        { _id: conv._id },
        { 
          $push: { 
            historial: { 
              $each: [
                { role: "user", content: texto }, 
                { role: "assistant", content: respuestaIA }
              ], 
              $slice: -10 
            } 
          } 
        }
      );

      return message.reply(respuestaIA);

    } catch (err) {
      console.error("Error:", err.message);
    }
  });

  client.initialize();
}

crearCliente("inmobiliaria", promptInmobiliaria);
