import { MongoClient } from "mongodb";
import 'dotenv/config';
import pkg from "whatsapp-web.js";
const { Client, LocalAuth, MessageMedia } = pkg;
import qrcode from "qrcode-terminal";
import Groq from "groq-sdk";
import { Readable } from "stream";
import { promptInmobiliaria } from "./prompts/inmobiliaria.js";
import { promptToronja } from "./prompts/toronja.js";
import express from "express";
import fs from "fs";
import { execSync } from "child_process";
import cors from "cors";
import { google } from "googleapis"; // 📅 Nueva importación

// ==========================================
// 📅 CONFIGURACIÓN GOOGLE CALENDAR
// ==========================================
const SCOPES = ["https://www.googleapis.com/auth/calendar"];
const auth = new google.auth.GoogleAuth({
  keyFile: "credentials.json", // Tu archivo descargado
  scopes: SCOPES,
});
const calendar = google.calendar({ version: "v3", auth });
const CALENDAR_ID = "primary"; 

async function agendarEnGoogle(fechaInicio, botNombre, telefono) {
  try {
    const end = new Date(fechaInicio);
    end.setHours(end.getHours() + 1); // Turno de 1 hora

    const event = {
      summary: `Reserva: ${botNombre.toUpperCase()} - ${telefono}`,
      description: `Agendado automáticamente por BOT-DYLAN\nCliente: ${telefono}`,
      start: {
        dateTime: fechaInicio.toISOString(),
        timeZone: "America/Argentina/Buenos_Aires",
      },
      end: {
        dateTime: end.toISOString(),
        timeZone: "America/Argentina/Buenos_Aires",
      },
    };

    await calendar.events.insert({
      calendarId: CALENDAR_ID,
      resource: event,
    });
    console.log(`📅 Evento agendado para ${botNombre} - ${telefono}`);
  } catch (error) {
    console.error("❌ Error en Google Calendar:", error);
  }
}

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
// 📱 FÁBRICA DE BOTS
// ==========================================
async function crearCliente(nombre, promptPersonalizado) {
  const isRender = process.env.RENDER === "true";
  const persistencePath = isRender ? "/var/data" : "./.wwebjs_auth";

  if (isRender) {
    try {
      execSync(`find ${persistencePath} -name "SingletonLock" -exec rm -f {} +`);
    } catch (e) { console.log("Aviso limpieza:", e.message); }
  }

  if (!fs.existsSync(persistencePath)) fs.mkdirSync(persistencePath, { recursive: true });

  const client = new Client({
    authStrategy: new LocalAuth({ clientId: nombre, dataPath: persistencePath }),
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

      // --- Audios ---
      if (message.hasMedia && (message.type === 'audio' || message.type === 'ptt')) {
        try {
          const media = await message.downloadMedia();
          const buffer = Buffer.from(media.data, 'base64');
          const stream = Readable.from(buffer);
          stream.path = "audio.ogg"; 
          const transcription = await groq.audio.transcriptions.create({
            file: stream,
            model: "whisper-large-v3",
            language: "es",
          });
          texto = transcription.text;
        } catch (audioErr) {
          return message.reply("No pude entender el audio, ¿me lo transcribís? ✍️");
        }
      }

      if (!texto || texto.trim() === "") return;
      const textoLower = texto.toLowerCase().trim();

      // --- Lógica de Estados ---
      let conv = await conversaciones.findOne({ telefono: message.from, botId: nombre });
      if (!conv) {
        conv = { telefono: message.from, estado: "inicio", botId: nombre, historial: [] };
        await conversaciones.insertOne(conv);
        if (nombre === "inmobiliaria") {
          const saludoInmo = `Hola, buenas tardes. Soy Sofía de Soldani Propiedades.\n\nLe comparto nuestro *Brochure 2026* actualizado.\n\n¿En qué zona se encuentra el terreno?`;
          const pathPdf = "./Brochure 2026.pdf";
          if (fs.existsSync(pathPdf)) {
            const media = MessageMedia.fromFilePath(pathPdf);
            await client.sendMessage(message.from, media, { caption: saludoInmo });
          } else {
            await message.reply(saludoInmo);
          }
          await conversaciones.updateOne({ _id: conv._id }, { $push: { historial: { role: "assistant", content: saludoInmo } } });
          return;
        }
      }

      // Confirmación de reserva y Google Calendar
      if (conv.estado === "pendiente_confirmacion") {
        if (["si", "sí", "dale", "ok", "de una", "perfecto", "confirmar", "confirmo"].includes(textoLower)) {
          const numFinal = message.from ? String(message.from).split('@')[0] : "desconocido";
          const fechaTurno = new Date(conv.fechaTurnoTemp);

          // 1. Guardar en DB
          await reservas.insertOne({
            botId: nombre,
            telefono: numFinal,
            fechaTurno: fechaTurno,
            estado: "confirmado",
            fechaSolicitud: new Date()
          });

          // 2. 📅 Agendar en Google Calendar
          await agendarEnGoogle(fechaTurno, nombre, numFinal);

          await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "cerrada" } });
          return message.reply("✅ ¡Excelente! Ya agendé tu turno en el calendario. Te esperamos.");
        }
      }

      // El resto de la lógica de estados...
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

      const resultado = parsearFechaTurno(textoLower);

if (resultado.diaDetectado && resultado.horaDetectada) {
  const fechaFinal = new Date(resultado.fecha);

  await conversaciones.updateOne(
    { _id: conv._id },
    { 
      $set: { 
        estado: "pendiente_confirmacion",
        fechaTurnoTemp: fechaFinal 
      } 
    }
  );

  return message.reply(
    `Perfecto, ¿confirmamos el turno para el ${fechaFinal.toLocaleString("es-AR")}? (SI/NO)`
  );
}

      if (palabrasCierre.some(p => textoLower === p)) {
        await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "cerrada" } });
        return message.reply("¡De nada! 😊");
      }

      // --- IA ---
      const convActualizada = await conversaciones.findOne({ _id: conv._id });
      const completion = await groq.chat.completions.create({
        messages: [{ role: "system", content: promptPersonalizado }, ...(convActualizada.historial || []).slice(-8), { role: "user", content: texto }],
        model: "llama-3.1-8b-instant"
      });

      const respuestaIA = completion.choices[0].message.content;
      await conversaciones.updateOne({ _id: conv._id }, { 
        $push: { historial: { $each: [{ role: "user", content: texto }, { role: "assistant", content: respuestaIA }], $slice: -20 } } 
      });

      return message.reply(respuestaIA);

    } catch (err) { console.error(`Error en bot ${nombre}:`, err); }
  });

  client.initialize();
}

// Lanzar los bots
crearCliente("inmobiliaria", promptInmobiliaria);
crearCliente("toronja", promptToronja);
