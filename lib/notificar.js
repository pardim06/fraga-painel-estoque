// lib/notificar.js
//
// Canal de alerta compartilhado — tenta nessa ordem: CallMeBot (WhatsApp
// grátis) → Z-API (WhatsApp pago) → e-mail via Gmail. Usado pelo verificador
// de estoque e pelo vigia do sistema.

const axios = require('axios');
const nodemailer = require('nodemailer');

const CALLMEBOT_PHONE = process.env.CALLMEBOT_PHONE;
const CALLMEBOT_APIKEY = process.env.CALLMEBOT_APIKEY;
const ZAPI_INSTANCE_URL = process.env.ZAPI_INSTANCE_URL;
const WHATSAPP_DESTINO = process.env.WHATSAPP_DESTINO;
const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const EMAIL_DESTINO = process.env.EMAIL_DESTINO || GMAIL_USER;

// mensagem: texto em WhatsApp markdown (*negrito*), sem acento é removido só
// na hora de mandar pro CallMeBot. assunto: usado só no e-mail.
async function enviarNotificacao(mensagem, assunto) {
  if (CALLMEBOT_PHONE && CALLMEBOT_APIKEY) {
    // A API gratuita do CallMeBot rejeita mensagem com acento (ç, ã, ê etc.)
    // com "invalid charecters" — e nome de produto quase sempre tem.
    const semAcento = mensagem.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const resp = await axios.get('https://api.callmebot.com/whatsapp.php', {
      params: { phone: CALLMEBOT_PHONE, text: semAcento, apikey: CALLMEBOT_APIKEY },
    });
    // O CallMeBot às vezes devolve status 2xx com um corpo de erro (ex: conta
    // pausada por excesso de uso) sem a palavra "Error" — checar só isso
    // fazia o script achar que enviou quando na verdade não enviou nada.
    const falhou =
      resp.status !== 200 ||
      (typeof resp.data === 'string' &&
        /error|paused|pausada|blocked|bloqueada/i.test(resp.data));
    if (falhou) {
      console.log(`Aviso: CallMeBot não confirmou o envio (status ${resp.status}): ${String(resp.data).slice(0, 300)}`);
    } else {
      console.log('Notificação enviada via CallMeBot.');
      return true;
    }
  }

  if (ZAPI_INSTANCE_URL && WHATSAPP_DESTINO) {
    await axios.post(`${ZAPI_INSTANCE_URL}/send-text`, {
      phone: WHATSAPP_DESTINO,
      message: mensagem,
    });
    console.log('Notificação enviada via Z-API.');
    return true;
  }

  if (GMAIL_USER && GMAIL_APP_PASSWORD && EMAIL_DESTINO) {
    const transporte = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: GMAIL_USER, pass: GMAIL_APP_PASSWORD },
    });

    await transporte.sendMail({
      from: GMAIL_USER,
      to: EMAIL_DESTINO,
      subject: assunto || 'Alerta do sistema Fraga',
      text: mensagem,
    });
    console.log(`Notificação enviada por e-mail pra ${EMAIL_DESTINO}.`);
    return true;
  }

  console.log('Nenhum canal de notificação configurado (CallMeBot, Z-API ou Gmail).');
  return false;
}

module.exports = { enviarNotificacao };
