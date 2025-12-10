const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json()); // ✅ only this, no bodyParser.json
app.use(express.urlencoded({ extended: true }));

// Routes
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.post('/api/book', (req, res) => {
  console.log("Booking received:", req.body);
  res.json({ status: 'success', booking: req.body });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
}); // Serve static files
// Configuration
const DARAJA_CONSUMER_KEY = process.env.DARAJA_CONSUMER_KEY || 'FYDGIEuCqS8fQB1m0JjewGnGfH1xDqeCte3myM1CYz9IsgHR';
const DARAJA_CONSUMER_SECRET = process.env.DARAJA_CONSUMER_SECRET || '50o2I8Rll0yfShgcYIOb3gquX9wNZFs6YJEfRu9tqG194qhcW3jepD9dEfjGymU9';
const DARAJA_BUSINESS_SHORTCODE = process.env.DARAJA_BUSINESS_SHORTCODE || '174379';
const DARAJA_PASSKEY = process.env.DARAJA_PASSKEY || 'b7BntFzEKYMhu6Cdd5b9srIjXDf8wqs84Go+XsDprjyNOXSClyVT1LwkBsh4vLHmBz+5S0+hxfST+R/d08GbSfUeoEmQPjpe98HaMdX3YlGF+pmAIWv+KzXJPJeqRe/sz1aUATnr4ZKFugnz/ZU/aYX9eNuvC3fuaAEd+y6zSd/fJ1e3l/H1n+rKQEUrmdgBOtGEMXbydgWOI843u7zTTz8r0Rk+r5WNtLJvCx5vj/bQhA2NDg5iyasDx2e4H0sDBGf+WeRBG1TRj4aRKGv3Y8WXMgqHtV4/kh+ukrg4mTVy5U3AtSUxbKjfkc7ArlS+wTxES8AdU4drB9gUWceNIQ==';
const SENDER_EMAIL = process.env.SENDER_EMAIL || 'amoohmike@gmail.com';
const SENDER_PASSWORD = process.env.SENDER_PASSWORD || 'plcdskxwexewfbgx';
const PORT = process.env.PORT || 5000;
// Payment modes
const PAYMENT_MODES = {
  mpesa: { name: "M-Pesa", icon: "📱", description: "Pay via M-Pesa" },
  card: { name: "Credit/Debit Card", icon: "💳", description: "Visa, Mastercard" },
  bank: { name: "Bank Transfer", icon: "🏦", description: "Direct Bank Transfer" },
  airtel: { name: "Airtel Money", icon: "📲", description: "Airtel Money Wallet" }
};

// Pricing
const PRICING = {
  VIP: { rows: ["A", "B"], price: 1200 },
  REGULAR: { rows: ["C", "D", "E", "F"], price: 700 },
  ECONOMY: { rows: ["G", "H"], price: 350 }
};

// Events storage
let EVENTS = {};

// Load events from HTML
function loadEventsFromHtml() {
  try {
    const eventHtmlPath = path.join(__dirname, 'event.html');
    if (fs.existsSync(eventHtmlPath)) {
      const html = fs.readFileSync(eventHtmlPath, 'utf-8');
      const $ = cheerio.load(html);
      
      $('event').each((i, el) => {
        const eventId = $(el).attr('id');
        const title = $(el).find('title').text();
        const date = $(el).find('date').text();
        const time = $(el).find('time').text();
        const venue = $(el).find('venue').text();
        const imageUrl = $(el).find('image_url').text();
        
        if (new Date(date) > new Date()) {
          EVENTS[eventId] = { title, date, time, venue, image_url: imageUrl };
        }
      });
      console.log('✅ Events loaded from event.html');
    } else {
      console.warn('⚠️ event.html not found. Skipping event loading.');
    }
  } catch (err) {
    console.error(`⚠️ Error loading events: ${err.message}`);
  }
}

loadEventsFromHtml();

// Get Daraja access token
async function getDarajaAccessToken() {
  try {
    const auth = Buffer.from(`${DARAJA_CONSUMER_KEY}:${DARAJA_CONSUMER_SECRET}`).toString('base64');
    const response = await axios.get('https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials', {
      headers: { Authorization: `Basic ${auth}` },
      timeout: 10000
    });
    return response.data.access_token;
  } catch (err) {
    console.error(`❌ Token Error: ${err.message}`);
    return null;
  }
}

// Initiate STK Push
async function initiateSTKPush(phone, amount, reference) {
  try {
    const accessToken = await getDarajaAccessToken();
    if (!accessToken) return { error: 'Failed to get access token' };

    const timestamp = new Date().toISOString().replace(/[:-]/g, '').split('.')[0];
    const password = Buffer.from(`${DARAJA_BUSINESS_SHORTCODE}${DARAJA_PASSKEY}${timestamp}`).toString('base64');

    const url = 'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest';
    const payload = {
      BusinessShortCode: DARAJA_BUSINESS_SHORTCODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: parseInt(amount),
      PartyA: phone,
      PartyB: DARAJA_BUSINESS_SHORTCODE,
      PhoneNumber: phone,
      CallBackURL: 'https://yourdomain.com/api/payment/callback',
      AccountReference: reference,
      TransactionDesc: 'Gold Cinema Ticket Payment'
    };

    const response = await axios.post(url, payload, {
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      timeout: 10000
    });

    console.log(`📡 STK Push Response: ${response.status}`);
    return response.data;
  } catch (err) {
    console.error(`❌ STK Push Error: ${err.message}`);
    return { error: err.message };
  }
}

// Send ticket email
async function sendTicketEmail(toEmail, phone, tickets, amount, seats, ticketId, event, paymentMode) {
  const paymentInfo = PAYMENT_MODES[paymentMode] || PAYMENT_MODES.mpesa;
  const subject = `🎬 Your Gold Cinema Ticket - ${event.title} (Confirmation)`;
  const now = new Date().toLocaleString();
  const eventDate = event.date || 'TBA';
  const eventTime = event.time || 'TBA';

  const paymentBadgeHtml = `
    <div class="payment-info">
      <strong>💳 Payment Method:</strong> ${paymentInfo.icon} ${paymentInfo.name}<br>
      <strong>Description:</strong> ${paymentInfo.description}
    </div>
  `;

  const html = `
    <html>
    <head>
      <style>
        body { background: #0f0f0f; color: #e0e0e0; font-family: 'Segoe UI', Arial; }
        .container { max-width: 650px; margin: 0 auto; background: #1a1a1a; border-radius: 15px; padding: 30px; border: 2px solid #d4af37; box-shadow: 0 8px 20px rgba(212, 175, 55, 0.2); }
        .header { text-align: center; margin-bottom: 30px; }
        .header h1 { color: #d4af37; font-size: 28px; margin: 0; text-shadow: 0 0 10px rgba(212, 175, 55, 0.3); }
        .booking-id { background: #0f0f0f; padding: 15px; border-radius: 10px; border-left: 4px solid #d4af37; margin: 20px 0; text-align: center; }
        .booking-id strong { color: #d4af37; font-size: 18px; }
        .details-table { width: 100%; margin: 20px 0; border-collapse: collapse; }
        .details-table tr { border-bottom: 1px solid #333; }
        .details-table td { padding: 12px; }
        .details-table td:first-child { color: #d4af37; font-weight: bold; width: 35%; }
        .event-card { background: #252525; border: 1px solid #444; border-radius: 10px; padding: 20px; margin: 20px 0; }
        .event-card h3 { color: #d4af37; margin: 0 0 10px 0; }
        .payment-badge { background: #1d5d1d; color: #4ade80; padding: 10px 15px; border-radius: 8px; text-align: center; margin: 20px 0; font-weight: bold; }
        .payment-info { background: #252525; border: 1px solid #d4af37; border-radius: 10px; padding: 15px; margin: 20px 0; color: #e0e0e0; }
        .footer { text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #333; color: #888; font-size: 12px; }
        .footer a { color: #d4af37; text-decoration: none; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🎬 Booking Confirmed!</h1>
          <p>Your tickets are ready</p>
        </div>
        <div class="booking-id">
          <strong>Booking ID: ${ticketId}</strong>
        </div>
        <div class="event-card">
          <h3>${event.title}</h3>
          <table class="details-table">
            <tr><td>📅 Date</td><td>${eventDate}</td></tr>
            <tr><td>🕐 Time</td><td>${eventTime}</td></tr>
            <tr><td>📍 Venue</td><td>${event.venue || 'Gold Cinema'}</td></tr>
          </table>
        </div>
        <table class="details-table">
          <tr><td>👤 Guest</td><td>${toEmail}</td></tr>
          <tr><td>📞 Phone</td><td>${phone}</td></tr>
          <tr><td>🎫 Tickets</td><td>${tickets}</td></tr>
          <tr><td>💺 Seats</td><td><strong>${seats.join(', ')}</strong></td></tr>
          <tr><td>💰 Amount</td><td><strong style="color: #d4af37;">Ksh. ${amount.toLocaleString()}</strong></td></tr>
          <tr><td>⏱️ Booked At</td><td>${now}</td></tr>
        </table>
        ${paymentBadgeHtml}
        <div class="payment-badge">✅ Payment Status: Pending Confirmation</div>
        <div class="footer">
          <p>For support, contact us: <a href="mailto:${SENDER_EMAIL}">${SENDER_EMAIL}</a></p>
          <p><strong>Gold Cinema</strong> – Elevate Your Movie Experience!</p>
          <p style="color: #666; margin-top: 15px;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    </body>
    </html>
  `;

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: { user: SENDER_EMAIL, pass: SENDER_PASSWORD }
    });

    await transporter.sendMail({
      from: SENDER_EMAIL,
      to: toEmail,
      subject: subject,
      html: html
    });

    console.log('✅ Email sent successfully');
    return true;
  } catch (err) {
    console.error(`❌ Email failed: ${err.message}`);
    return false;
  }
}

// Calculate amount
function calculateAmount(seats) {
  let amount = 0;
  seats.forEach(seat => {
    const row = seat[0].toUpperCase();
    for (const [_, pricing] of Object.entries(PRICING)) {
      if (pricing.rows.includes(row)) {
        amount += pricing.price;
        break;
      }
    }
  });
  return amount;
}

// Get event details
function getEventDetails(eventId) {
  return EVENTS[eventId] || {
    title: 'Gold Cinema Event',
    date: new Date().toISOString().split('T')[0],
    time: '19:00',
    venue: 'Gold Cinema',
    image_url: ''
  };
}

// Routes

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: '🟢 Server running' });
});

// Get access token
app.get('/api/token', async (req, res) => {
  try {
    const token = await getDarajaAccessToken();
    if (token) {
      res.json({ access_token: token });
    } else {
      res.status(500).json({ error: 'Failed to get token' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// STK Push
app.post('/api/stkpush', async (req, res) => {
  const { phone, amount, reference } = req.body;

  if (!phone || !amount) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const result = await initiateSTKPush(phone, amount, reference);
  res.json(result);
});

// Payment callback
app.post('/api/payment/callback', (req, res) => {
  const { Amount, PhoneNumber, MpesaReceiptNumber, ResultCode } = req.body;
  console.log(`📥 Callback: ${JSON.stringify(req.body)}`);

  res.json({
    amount: Amount,
    phone: PhoneNumber,
    receipt_number: MpesaReceiptNumber,
    result_code: ResultCode,
    status: ResultCode === '0' ? 'Success' : 'Failed'
  });
});

// Get payment modes
app.get('/api/payment-modes', (req, res) => {
  res.json(PAYMENT_MODES);
});

// Get events
app.get('/api/events', (req, res) => {
  res.json(Object.values(EVENTS));
});

// Book ticket
app.post('/api/book', async (req, res) => {
  try {
    const { email, phone, seats, event_id, payment_mode } = req.body;

    if (!email || !phone || !seats || seats.length === 0) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    if (!PAYMENT_MODES[payment_mode]) {
      return res.status(400).json({ error: `Invalid payment mode. Allowed: ${Object.keys(PAYMENT_MODES).join(', ')}` });
    }

    let phoneNum = phone.startsWith('254') ? phone : '254' + phone.replace(/^0/, '');
    const amount = calculateAmount(seats);

    if (amount <= 0) {
      return res.status(400).json({ error: 'Invalid seat selection' });
    }

    const event = getEventDetails(event_id || 'gold-cinema-001');
    const ticketId = uuidv4().replace(/-/g, '').substring(0, 15);

    const emailSent = await sendTicketEmail(email, phoneNum, seats.length, amount, seats, ticketId, event, payment_mode);

    let paymentResponse = {};
    if (payment_mode === 'mpesa') {
      paymentResponse = await initiateSTKPush(phoneNum, amount, ticketId);
    } else {
      paymentResponse = { status: 'pending', message: `Please proceed with ${PAYMENT_MODES[payment_mode].name} payment` };
    }

    res.status(201).json({
      success: true,
      message: 'Booking successful! Check your email for ticket details.',
      ticket_id: ticketId,
      amount: amount,
      event: event,
      payment_mode: payment_mode,
      payment_info: PAYMENT_MODES[payment_mode],
      email_sent: emailSent,
      payment_response: paymentResponse
    });

  } catch (err) {
    console.error(`❌ Booking error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Admin API endpoints (wire with admin.html)

// Get all users (from admin)
app.get('/api/admin/users', (req, res) => {
  const users = JSON.parse(localStorage.getItem('gv_users') || '{}');
  res.json(users);
});

// Get all events (from admin)
app.get('/api/admin/events', (req, res) => {
  const events = JSON.parse(localStorage.getItem('gv_events') || '[]');
  res.json(events);
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Health: http://localhost:${PORT}/api/health`);
  console.log(`📝 Book: POST http://localhost:${PORT}/api/book`);
});