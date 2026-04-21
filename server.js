import { MongoClient } from "mongodb";
import 'dotenv/config';
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import Groq from "groq-sdk";
import { Readable } from "stream";
import { promptInmobiliaria } from "./prompts/inmobiliaria.js";

// ==========================================
// 🌐 CONFIG PUPPETEER (OPTIMIZADO PARA RAM)
// ==========================================
function getPuppeteerConfig() {
  const isRender = process.env.RENDER === "true";

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-accelerated-2d-canvas',
    '--no-first-run',
    '--no-zygote',
    '--disable-gpu',
    '--single-process', // Crítico en Render
    '--disable-extensions',
    // Bloquea recursos innecesarios para ahorrar RAM
    '--proxy-server="direct://"',
    '--proxy-bypass-list=*'
  ];

  if (isRender) {
    const execId = Date.now(); 
    return {
      headless: true,
      args: [
        ...args,
        `--user-data-dir=/var/data/chrome-profiles/${execId}` 
      ]
    };
  }

  return {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: args
  };
}

// 🔌 MongoDB (Cerramos conexiones si no se usan - opcional)
const uri = process.env.MONGO_URI;
const clientDB = new MongoClient(uri, {
  maxPoolSize: 5, // Limita conexiones para ahorrar memoria
  serverSelectionTimeoutMS: 5000
});
await clientDB.connect();

const db = clientDB.db("coworking");
const reservas = db.collection("reservas");
const conversaciones = db.collection("conversaciones");

console.log("Conectado a MongoDB ✅");

// 🤖 IA
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// [Funciones de parseo de fecha y palabras de cierre se mantienen igual...]
function parsearFechaTurno(texto) { /* ... misma lógica ... */ }
const palabrasCierre = ["chau", "chao", "adios", "adiós", "nos vemos", "hasta luego", "bye", "gracias", "impecable", "joya"];

// ==========================================
// 📱 FÁBRICA DE BOTS
// ==========================================
function crearCliente(nombre, promptPersonalizado) {
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: nombre,
      dataPath: process.env.RENDER ? `/var/data/.wwebjs_auth/${nombre}` : `./.wwebjs_auth/${nombre}`
    }),
    // Opciones de WebCache para evitar cargar versiones viejas pesadas
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    },
    puppeteer: getPuppeteerConfig()
  });

  client.on("qr", (qr) => {
    console.log(`\n--- QR DE ${nombre.toUpperCase()} ---`);
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => {
    console.log(`✅ WhatsApp ${nombre} conectado 🚀`);
  });

  client.on("message", async (message) => {
    try {
      // Filtro agresivo para ignorar mensajes que no necesitamos procesar
      if (message.fromMe || message.from.includes("@g.us") || message.from === 'status@broadcast' || message.type === 'protocol') return;

      let texto = message.body || "";

      // Procesar audio solo si es necesario (Groq es externo, pero el buffer es local)
      if (message.hasMedia && (message.type === 'audio' || message.type === 'ptt')) {
        const media = await message.downloadMedia();
        if (!media) return;
        const buffer = Buffer.from(media.data, 'base64');
        const stream = Readable.from(buffer);
        stream.path = "audio.ogg";
        const transcription = await groq.audio.transcriptions.create({
          file: stream,
          model: "whisper-large-v3",
          language: "es",
        });
        texto = transcription.text;
      }

      if (message.hasMedia && message.type === 'image') {
        return message.reply("¡Recibí tu imagen! En un momento la revisamos.");
      }

      if (!texto || texto.trim() === "") return;
      const textoLower = texto.toLowerCase().trim();

      // [Lógica de estados y base de datos se mantiene igual...]
      let conv = await conversaciones.findOne({ telefono: message.from, botId: nombre });
      if (!conv) {
        conv = { telefono: message.from, estado: "inicio", botId: nombre, historial: [] };
        await conversaciones.insertOne(conv);
        if (nombre === "inmobiliaria") {
          const saludoInmo = `Hola, buenas tardes. Soy Sofía de Soldani Propiedades.\n\nLe comparto el enlace donde puede ver el *Brochure 2026*: http://bit.ly/4trNVVr\n\n¿En qué zona se encuentra el terreno?`;
          await conversaciones.updateOne({ _id: conv._id }, { $push: { historial: { role: "assistant", content: saludoInmo } } });
          return message.reply(saludoInmo);
        }
      }

      // ... resto de tu lógica de reservas ...
      // (Mantener el slice(-8) de historial es clave para no saturar el payload)

      const completion = await groq.chat.completions.create({
        messages: [{ role: "system", content: promptPersonalizado }, ...conv.historial.slice(-8), { role: "user", content: texto }],
        model: "llama-3.1-8b-instant"
      });

      const respuestaIA = completion.choices[0].message.content;

      await conversaciones.updateOne({ _id: conv._id }, { 
        $push: { historial: { $each: [{ role: "user", content: texto }, { role: "assistant", content: respuestaIA }], $slice: -15 } } 
      });

      return message.reply(respuestaIA);

    } catch (err) {
      console.error(`Error en bot ${nombre}:`, err);
    }
  });

  client.initialize();
}

crearCliente("inmobiliaria", promptInmobiliaria);
