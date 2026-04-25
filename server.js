import { MongoClient } from "mongodb";
import 'dotenv/config';
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import Groq from "groq-sdk";
import { Readable } from "stream";
import { promptInmobiliaria } from "./prompts/inmobiliaria.js";
import express from "express";
import fs from "fs";
import { execSync } from "child_process";
import cors from "cors";

// ==========================================
// 🌐 SERVIDOR PARA RENDER (EVITA REINICIOS)
// ==========================================
const app = express();

app.use(cors({
  origin: "*", 
  methods: ["GET", "POST"],
  allowedHeaders: ["Content-Type"]
}));

const port = process.env.PORT || 10000;
app.get('/', (req, res) => res.send('BOT-DYLAN ONLINE 🚀'));

app.get("/datos", async (req, res) => {
  try {
    const data = await reservas.find().sort({ fechaSolicitud: -1 }).limit(50).toArray();
    const datosFormateados = data.map(r => {
      let telefonoLimpio = "Sin número";
      if (r.telefono) {
        telefonoLimpio = String(r.telefono).split('@')[0];
      }
      return {
        id: r._id,
        fecha: r.fechaSolicitud ? new Date(r.fechaSolicitud).toLocaleDateString("es-AR") : "S/F",
        cliente: telefonoLimpio,
        consulta: "Reserva de turno",
        estado: r.estado || "pendiente"
      };
    });
    res.json(datosFormateados);
  } catch (error) {
    console.error("❌ Error en /datos:", error);
    res.status(500).json({ error: "Error al obtener datos" });
  }
});

app.listen(port, '0.0.0.0', () => console.log(`🌍 Server listening on port ${port}`));

// ==========================================
// 🌐 CONFIG PUPPETEER
// ==========================================
function getPuppeteerConfig() {
  const isRender = process.env.RENDER === "true";
  if (isRender) {
    return {
      headless: true,
      args: [
        '--no-sandbox', 
        '--disable-setuid-sandbox', 
        '--disable-dev-shm-usage',
        '--disable-gpu', 
        '--no-zygote', 
        '--single-process'
      ]
    };
  }
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
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ==========================================
// 🧠 PARSER DE FECHAS
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

  const matchDia = texto.match(/\bel\s?(\d{1,2})\b/);
  if (matchDia) {
    const dia = parseInt(matchDia[1]);
    fecha.setDate(dia);
    if (fecha < ahora) fecha.setMonth(fecha.getMonth() + 1);
    diaDetectado = true;
  }

  const matchesHora = [...texto.matchAll(/(\d{1,2})(:(\d{2}))?\s*(hs|horas)?/g)];
  if (matchesHora.length > 0) {
    const matchHora = matchesHora[matchesHora.length - 1];
    const hora = parseInt(matchHora[1], 10);
    const minutos = matchHora[3] ? parseInt(matchHora[3], 10) : 0;
    fecha.setHours(hora, minutos, 0, 0);
    horaDetectada = true;
  } else {
    fecha.setHours(0, 0, 0, 0);
  }

  return { fecha, horaDetectada, diaDetectado };
}

const palabrasCierre = ["chau", "chao", "adios", "adiós", "nos vemos", "hasta luego", "bye", "gracias", "impecable", "joya"];

// ==========================================
// 📱 FÁBRICA DE BOTS (SIN DELAYS)
// ==========================================
async function crearCliente(nombre, promptPersonalizado) {
  const isRender = process.env.RENDER === "true";
  const persistencePath = isRender ? "/var/data" : "./.wwebjs_auth";
  const sessionPath = `${persistencePath}/session-${nombre}`;

  if (isRender) {
    try {
      console.log(`🧹 Limpiando bloqueos para ${nombre}...`);
      execSync("rm -rf /var/data/chrome-profile/SingletonLock");
      const lockPath = `${sessionPath}/Default/SingletonLock`;
      if (fs.existsSync(lockPath)) {
        console.log("🔓 Desbloqueando sesión específica...");
        execSync(`rm -f ${lockPath}`);
      }
    } catch (e) {
      console.log("Aviso en limpieza:", e.message);
    }
  }
  if (!fs.existsSync(persistencePath)) {
    fs.mkdirSync(persistencePath, { recursive: true });
  }

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: nombre,
      dataPath: persistencePath
    }),
    puppeteer: getPuppeteerConfig()
  });

  client.on("qr", (qr) => {
    console.log(`\n--- QR DE ${nombre.toUpperCase()} ---`);
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => console.log(`✅ WhatsApp ${nombre} conectado 🚀`));

  client.on("message", async (message) => {
    try {
      if (message.fromMe || message.from.includes("@g.us") || message.from === 'status@broadcast') return;
      let texto = message.body || "";

      // --- Gestión de Audios ---
      if (message.hasMedia && (message.type === 'audio' || message.type === 'ptt')) {
        try {
          const media = await message.downloadMedia();
          if (media && media.data) {
            const buffer = Buffer.from(media.data, 'base64');
            const stream = Readable.from(buffer);
            stream.path = "audio.ogg"; 
            const transcription = await groq.audio.transcriptions.create({
              file: stream,
              model: "whisper-large-v3",
              language: "es",
            });
            texto = transcription.text;
            console.log(`🎙️ Audio transcripto (${nombre}): ${texto}`);
          }
        } catch (audioErr) {
          console.error(`❌ Error audio:`, audioErr);
          return message.reply("No pude entender el audio, ¿me lo transcribís? ✍️");
        }
      }

      if (message.hasMedia && message.type === 'image') {
        return message.reply("¡Recibí tu imagen! En un momento la revisamos.");
      }

      if (!texto || texto.trim() === "") return;
      const textoLower = texto.toLowerCase().trim();

      // --- Lógica de Conversación y Estados ---
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

      const palabrasReapertura = ["hola", "buenas", "consulta", "necesito", "quiero", "turno", "che"];
      
      if (conv.estado === "cerrada" && palabrasReapertura.some(p => textoLower.includes(p))) {
        await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "inicio" } });
        conv.estado = "inicio";
      }

      if (conv.estado === "pendiente_confirmacion") {
        if (["si", "sí", "dale", "ok", "de una", "perfecto", "confirmar", "confirmo"].includes(textoLower)) {
          const numFinal = message.from ? String(message.from).split('@')[0] : "desconocido";
          
          await reservas.insertOne({
            botId: nombre,
            telefono: numFinal,
            fechaTurno: new Date(conv.fechaTurnoTemp),
            estado: "pendiente",
            fechaSolicitud: new Date()
          });
          await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "cerrada" } });
          return message.reply("✅ Reserva tomada. Te confirmamos pronto.");
        }
      }

      if (conv.estado === "esperando_horario") {
        const resultado = parsearFechaTurno(textoLower);
        if (resultado && resultado.horaDetectada) {
          let fechaFinal = new Date(resultado.fecha);
          if (conv.fechaTurnoTemp) {
            const base = new Date(conv.fechaTurnoTemp);
            base.setHours(fechaFinal.getHours(), fechaFinal.getMinutes(), 0, 0);
            fechaFinal = base;
          }
          await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "pendiente_confirmacion", fechaTurnoTemp: fechaFinal } });
          return message.reply(`¿Confirmamos el turno para el ${fechaFinal.toLocaleString("es-AR")}? (SI/NO)`);
        }
      }

      if (palabrasCierre.some(p => textoLower === p)) {
        await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "cerrada" } });
        return message.reply("¡De nada! 😊");
      }

      // --- Respuesta de la IA con Groq ---
      const convActualizada = await conversaciones.findOne({ _id: conv._id });
      const historialChat = convActualizada.historial || [];

      const completion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: promptPersonalizado }, 
          ...historialChat.slice(-8), 
          { role: "user", content: texto }
        ],
        model: "llama-3.1-8b-instant"
      });

      const respuestaIA = completion.choices[0].message.content;
      
      await conversaciones.updateOne({ _id: conv._id }, { 
        $push: { historial: { $each: [{ role: "user", content: texto }, { role: "assistant", content: respuestaIA }], $slice: -20 } } 
      });

      console.log(`🚀 Respondiendo inmediatamente a ${nombre}...`);
      return message.reply(respuestaIA);

    } catch (err) {
      console.error(`Error en bot ${nombre}:`, err);
    }
  });

  // Inicialización directa sin esperas largas
  console.log(`🚀 Inicializando cliente ${nombre}...`);
  client.initialize();
}

crearCliente("inmobiliaria", promptInmobiliaria);
