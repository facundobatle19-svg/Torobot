import { MongoClient } from "mongodb";
import 'dotenv/config';
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import Groq from "groq-sdk";
import { Readable } from "stream";
import express from "express"; // 👈 Agregado para el Keep-Alive de Render
import { promptInmobiliaria } from "./prompts/inmobiliaria.js";

// ==========================================
// 🚀 SERVIDOR EXPRESS PARA RENDER (KEEP-ALIVE)
// ==========================================
const app = express();
const port = process.env.PORT || 10000;
app.get("/", (req, res) => res.send("Bot Dylan / Inmobiliaria está operando 🚀"));
app.listen(port, "0.0.0.0", () => {
  console.log(`Servidor de monitoreo activo en puerto ${port}`);
});

// ==========================================
// 🌐 CONFIG PUPPETEER OPTIMIZADA
// ==========================================
function getPuppeteerConfig() {
  const isRender = process.env.RENDER === "true";

  if (isRender) {
    return {
      headless: true,
      // ELIMINAMOS la ruta fija y dejamos que puppeteer use el que instaló en el build
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ]
    };
  }

  // Local (Mac)
  return {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  };
}

// 🔌 MongoDB
const uri = process.env.MONGO_URI;
const clientDB = new MongoClient(uri);
await clientDB.connect();

const db = clientDB.db("coworking");
const reservas = db.collection("reservas");
const conversaciones = db.collection("conversaciones");

console.log("Conectado a MongoDB ✅");

// 🤖 IA
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

// ==========================================
// 🧠 PARSER DE FECHAS (Sin cambios)
// ==========================================
function parsearFechaTurno(texto) {
  const ahora = new Date();
  let fecha = new Date(ahora);
  let horaDetectada = false;
  let diaDetectado = false; 
  texto = texto.toLowerCase();

  const diasSemana = {
    domingo: 0, lunes: 1, martes: 2, miercoles: 3, miércoles: 3,
    jueves: 4, viernes: 5, sabado: 6, sábado: 6
  };

  if (texto.includes("pasado mañana")) {
    fecha.setDate(fecha.getDate() + 2);
    diaDetectado = true;
  } else if (texto.includes("mañana")) {
    fecha.setDate(fecha.getDate() + 1);
    diaDetectado = true;
  } else if (texto.includes("hoy")) {
    diaDetectado = true;
  }

  for (const dia in diasSemana) {
    if (texto.includes(dia)) {
      const hoy = ahora.getDay();
      const objetivo = diasSemana[dia];
      let diferencia = objetivo - hoy;
      if (texto.includes("que viene")) diferencia += 7;
      if (diferencia <= 0) diferencia += 7;
      fecha.setDate(ahora.getDate() + diferencia);
      diaDetectado = true;
    }
  }

  const matchFecha = texto.match(/\b(\d{1,2})[\/\-](\d{1,2})\b/);
  if (matchFecha) {
    const dia = parseInt(matchFecha[1]);
    const mes = parseInt(matchFecha[2]);
    if (mes >= 1 && mes <= 12) {
      fecha.setMonth(mes - 1);
      fecha.setDate(dia);
      diaDetectado = true;
    }
  }

  const matchesHora = [...texto.matchAll(/(\d{1,2})(:(\d{2}))?\s*(hs|horas)?/g)];
  if (matchesHora.length > 0) {
    const matchHora = matchesHora[matchesHora.length - 1];
    const hora = parseInt(matchHora[1], 10);
    const minutos = matchHora[3] ? parseInt(matchHora[3], 10) : 0;
    fecha.setHours(hora, minutos, 0, 0);
    horaDetectada = true;
  }

  return { fecha, horaDetectada, diaDetectado };
}

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
    webVersionCache: {
      type: 'remote',
      remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html`,
    },
    puppeteer: getPuppeteerConfig()
  });

  client.on("qr", (qr) => {
    console.log(`\n--- QR DE ${nombre.toUpperCase()} ---`);
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => console.log(`✅ WhatsApp ${nombre} conectado 🚀`));

  // Reinicio automático en caso de desconexión
  client.on("disconnected", (reason) => {
    console.log(`⚠️ Bot ${nombre} desconectado:`, reason);
    client.initialize();
  });

  client.on("message", async (message) => {
    try {
      if (message.fromMe || message.from.includes("@g.us") || message.from === 'status@broadcast') return;

      let texto = message.body || "";

      // Procesar Audio
      if (message.hasMedia && (message.type === 'audio' || message.type === 'ptt')) {
        const media = await message.downloadMedia();
        const buffer = Buffer.from(media.data, 'base64');
        const stream = Readable.from(buffer);
        const transcription = await groq.audio.transcriptions.create({
          file: stream,
          model: "whisper-large-v3",
          language: "es",
        });
        texto = transcription.text;
      }

      if (!texto || texto.trim() === "") return;
      const textoLower = texto.toLowerCase().trim();

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

      // Lógica de estados (Confirmación, Horarios, etc.)
      if (conv.estado === "pendiente_confirmacion") {
        if (["si", "sí", "dale", "ok", "de una", "perfecto", "confirmar", "confirmo"].includes(textoLower)) {
          await reservas.insertOne({
            botId: nombre,
            telefono: message.from,
            fechaTurno: new Date(conv.fechaTurnoTemp),
            estado: "pendiente",
            fechaSolicitud: new Date()
          });
          await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "cerrada" } });
          return message.reply("✅ Reserva tomada. Te confirmamos pronto.");
        }
      }

      // Respuesta de IA
      const completion = await groq.chat.completions.create({
        messages: [{ role: "system", content: promptPersonalizado }, ...(conv.historial || []).slice(-8), { role: "user", content: texto }],
        model: "llama-3.1-8b-instant"
      });

      const respuestaIA = completion.choices[0].message.content;

      await conversaciones.updateOne({ _id: conv._id }, { 
        $push: { historial: { $each: [{ role: "user", content: texto }, { role: "assistant", content: respuestaIA }], $slice: -20 } } 
      });

      return message.reply(respuestaIA);

    } catch (err) {
      console.error(`Error en bot ${nombre}:`, err);
    }
  });

  client.initialize();
}

crearCliente("inmobiliaria", promptInmobiliaria);
