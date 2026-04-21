import { MongoClient } from "mongodb";
import 'dotenv/config';
import pkg from "whatsapp-web.js";
const { Client, LocalAuth } = pkg;
import qrcode from "qrcode-terminal";
import Groq from "groq-sdk";
import { Readable } from "stream";
import { promptToronja } from "./prompts/toronja.js";
import { promptInmobiliaria } from "./prompts/inmobiliaria.js";
import puppeteer from "puppeteer";

// ==========================================
// 🌐 CONFIG PUPPETEER
// ==========================================
function getPuppeteerConfig() {
  const isRender = process.env.RENDER === "true";

  if (isRender) {
    return {
      headless: true,
      executablePath: "/usr/bin/chromium-browser", // 🔥 USAR EL DEL SISTEMA
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
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
const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

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
function crearCliente(nombre, promptPersonalizado) {
  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: nombre,
      dataPath: process.env.RENDER ? '/var/data/.wwebjs_auth' : './.wwebjs_auth'
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

      // 🎤 PROCESAR AUDIO
      if (message.hasMedia && (message.type === 'audio' || message.type === 'ptt')) {
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
      }

      if (message.hasMedia && message.type === 'image') {
        return message.reply("¡Recibí tu imagen! En un momento la revisamos.");
      }

      if (!texto || texto.trim() === "") return;
      const textoLower = texto.toLowerCase().trim();

      // Buscar o crear conversación
      let conv = await conversaciones.findOne({ telefono: message.from, botId: nombre });
      if (!conv) {
        conv = { 
          telefono: message.from, 
          estado: "inicio", 
          botId: nombre, 
          historial: [] 
        };
        await conversaciones.insertOne(conv);
        
        if (nombre === "inmobiliaria") {
          const saludoInmo = `Hola, buenas tardes. Soy Sofía de Soldani Propiedades.\n\nLe comparto el enlace donde puede ver el *Brochure 2026*: http://bit.ly/4trNVVr\n\n¿En qué zona se encuentra el terreno?`;
          await conversaciones.updateOne({ _id: conv._id }, { $push: { historial: { role: "assistant", content: saludoInmo } } });
          return message.reply(saludoInmo);
        }
      }

      // Reapertura
      const palabrasReapertura = ["hola", "buenas", "consulta", "necesito", "quiero", "turno", "che"];
      if (conv.estado === "cerrada" && palabrasReapertura.some(p => textoLower.includes(p))) {
        await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "inicio" } });
        conv.estado = "inicio";
      }

      const esPalabraNeutra = ["bueno", "dale", "ok", "listo", "perfecto", "dale dale"].includes(textoLower);

      // 1. ESTADO: PENDIENTE CONFIRMACIÓN (SI/NO)
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
        if (textoLower === "no") {
          await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "esperando_horario", fechaTurnoTemp: null } });
          return message.reply("Perfecto 👍 Decime otro día y horario.");
        }
      }

      // 2. ESTADO: ESPERANDO HORARIO
      if (conv.estado === "esperando_horario") {
        const resultado = parsearFechaTurno(textoLower);
        if (resultado && resultado.horaDetectada) {
          let fechaFinal = new Date(resultado.fecha);
          if (conv.fechaTurnoTemp) {
            const base = new Date(conv.fechaTurnoTemp);
            base.setHours(fechaFinal.getHours(), fechaFinal.getMinutes(), 0, 0);
            fechaFinal = base;
          }
          const ocupado = await reservas.findOne({
            botId: nombre,
            fechaTurno: { $gte: fechaFinal, $lt: new Date(fechaFinal.getTime() + 3600000) },
            estado: { $ne: "cancelado" }
          });
          if (ocupado) return message.reply("Ese horario ya está ocupado 😕");
          await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "pendiente_confirmacion", fechaTurnoTemp: fechaFinal } });
          return message.reply(`¿Confirmamos el turno para el ${fechaFinal.toLocaleString("es-AR")}? (SI/NO)`);
        }
        if (esPalabraNeutra) {
          return message.reply("¡Buenísimo! ¿A qué hora te anoto? (Atendemos de 7 a 18 hs)");
        }
      }

      // 3. DETECCIÓN INICIAL DE RESERVA (Ignora si es solo "bueno" o "dale")
      if (!esPalabraNeutra) {
        const palabrasReserva = ["turno", "reserva", "disponible", "ir", "voy", "pasar", "agendar", "sacar", "reservar"];
        const textoReservaFuerte = /reservar|sacar turno|confirmar|puede ser|ir a|visitar|mañana|hoy|hs|se puede|horario|a las/.test(textoLower);
        
        if (palabrasReserva.some(p => textoLower.includes(p)) || textoReservaFuerte) {
            const resultado = parsearFechaTurno(textoLower);
            if (resultado.fecha && resultado.horaDetectada && resultado.diaDetectado) {
              const ocupado = await reservas.findOne({
                botId: nombre,
                fechaTurno: { $gte: resultado.fecha, $lt: new Date(resultado.fecha.getTime() + 3600000) },
                estado: { $ne: "cancelado" }
              });
              if (ocupado) return message.reply("Ese horario ya está ocupado 😕");
              await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "pendiente_confirmacion", fechaTurnoTemp: resultado.fecha } });
              return message.reply(`¿Confirmamos el turno para el ${resultado.fecha.toLocaleString("es-AR")}? (SI/NO)`);
            }
            if (resultado.fecha && resultado.diaDetectado && !resultado.horaDetectada) {
              await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "esperando_horario", fechaTurnoTemp: resultado.fecha } });
              return message.reply("¡Obvio! ¿En qué horario te gustaría venir? (Atendemos de 7 a 18 hs)");
            }
        }
      }

      // 4. LÓGICA DE CIERRE
      if (palabrasCierre.some(p => textoLower === p || (textoLower.length < 10 && textoLower.includes(p)))) {
        await conversaciones.updateOne({ _id: conv._id }, { $set: { estado: "cerrada" } });
        return message.reply("¡De nada! 😊 Si necesitás algo más, avisame.");
      }

      // 5. IA CON MEMORIA PERSISTENTE
      if (conv.estado === "cerrada") return;

      const convActualizada = await conversaciones.findOne({ _id: conv._id });
      const historialChat = convActualizada.historial || [];

      const completion = await groq.chat.completions.create({
        messages: [
          { role: "system", content: promptPersonalizado },
          ...historialChat.slice(-8), // Enviamos los últimos 8 mensajes para contexto total
          { role: "user", content: texto }
        ],
        model: "llama-3.1-8b-instant"
      });

      const respuestaIA = completion.choices[0].message.content;

      // ACTUALIZACIÓN DE HISTORIAL (Guardamos la dupla pregunta-respuesta)
      await conversaciones.updateOne(
        { _id: conv._id },
        { 
          $push: { 
            historial: { 
              $each: [
                { role: "user", content: texto }, 
                { role: "assistant", content: respuestaIA }
              ], 
              $slice: -20 // Memoria de 20 mensajes
            } 
          } 
        }
      );

      // Respuesta especial para datos de contacto
      if (["teléfono", "email", "@", ".com"].some(p => respuestaIA.toLowerCase().includes(p))) {
        return message.reply("Dejanos tu consulta y te respondemos a la brevedad");
      }
      
      return message.reply(respuestaIA);

    } catch (err) {
      console.error(`Error en bot ${nombre}:`, err);
    }
  });

  client.initialize();
}

crearCliente("toronja", promptToronja);
crearCliente("inmobiliaria", promptInmobiliaria);
