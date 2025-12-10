require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const morgan = require('morgan');
const { v4: uuidv4 } = require('uuid');
const productions = require('./data/productions');
const advisors = require('./data/advisors');
const {
  createSeatMap,
  serializeSeatMap,
  seatsAreAvailable,
  holdSeats,
  finalizeSeats,
  releaseSeats
} = require('./utils/seatMap');
const { sendEmail } = require('./utils/mailer');
const { bookingConfirmation, bookingPending } = require('./utils/emailTemplates');

const app = express();
app.use(helmet());
app.use(
  cors({
    origin: (process.env.CLIENT_ORIGIN || '').split(',').filter(Boolean) || '*',
    credentials: true
  })
);
app.use(express.json({ limit: '2mb' }));
app.use(morgan('dev'));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 500,
    standardHeaders: true,
    legacyHeaders: false
  })
);

const PORT = process.env.PORT || 5000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const MPESA_ENV = (process.env.MPESA_ENV || 'sandbox').toLowerCase();
const MPESA_BASE_URL =
  MPESA_ENV === 'production' ? 'https://api.safaricom.co.ke' : 'https://sandbox.safaricom.co.ke';

const CALLBACK_PATH = process.env.MPESA_CALLBACK_URL || '/mpesa/callback';
const CALLBACK_URL =
  CALLBACK_PATH.startsWith('http') ? CALLBACK_PATH : `${BASE_URL}${CALLBACK_PATH}`;

const TOKEN_TTL_HOURS = Number(process.env.TOKEN_TTL_HOURS || 12);

const bookingsStore = new Map();
const usersById = new Map();
const usersByEmail = new Map();
const supportTickets = new Map(); // userId -> array
const advisorAssignments = new Map(); // userId -> advisor
const advisorLogs = [];
const performanceSeatMaps = new Map();

const requiredEnv = [
  'MPESA_CONSUMER_KEY',
  'MPESA_CONSUMER_SECRET',
  'MPESA_SHORT_CODE',
  'MPESA_PASSKEY',
  'JWT_SECRET'
];
requiredEnv.forEach((key) => {
  if (!process.env[key]) {
    console.warn(`⚠️ Missing environment variable: ${key}`);
  }
});

const sanitizePhone = (phone) => {
  if (!phone) return null;
  let cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = `254${cleaned.substring(1)}`;
  }
  if (!cleaned.startsWith('254')) {
    cleaned = `254${cleaned}`;
  }
  return cleaned;
};

const timestamp = () => {
  const date = new Date();
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(
    date.getDate()
  ).padStart(2, '0')}${String(date.getHours()).padStart(2, '0')}${String(
    date.getMinutes()
  ).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
};

const fetchMpesaToken = async () => {
  const auth = Buffer.from(
    `${process.env.MPESA_CONSUMER_KEY}:${process.env.MPESA_CONSUMER_SECRET}`
  ).toString('base64');

  const response = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: {
        Authorization: `Basic ${auth}`
      }
    }
  );

  return response.data.access_token;
};

const initiateStkPush = async ({ phone, amount, reference, description }) => {
  const accessToken = await fetchMpesaToken();
  const timeStamp = timestamp();
  const password = Buffer.from(
    `${process.env.MPESA_SHORT_CODE}${process.env.MPESA_PASSKEY}${timeStamp}`
  ).toString('base64');

  const payload = {
    BusinessShortCode: process.env.MPESA_SHORT_CODE,
    Password: password,
    Timestamp: timeStamp,
    TransactionType: 'CustomerPayBillOnline',
    Amount: Number(amount),
    PartyA: phone,
    PartyB: process.env.MPESA_SHORT_CODE,
    PhoneNumber: phone,
    CallBackURL: CALLBACK_URL,
    AccountReference: reference,
    TransactionDesc: description || 'Gold Cinema booking'
  };

  const response = await axios.post(
    `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
    payload,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`
      }
    }
  );

  return response.data;
};

const generateCustomerId = () => `GC${Math.floor(100000 + Math.random() * 900000)}`;

const toUserResponse = (user) => ({
  id: user.id,
  customerId: user.customerId,
  firstName: user.firstName,
  lastName: user.lastName,
  address: user.address,
  city: user.city,
  zipCode: user.zipCode,
  mobile: user.mobile,
  email: user.email,
  role: user.role,
  advisor: advisorAssignments.get(user.id) || null,
  createdAt: user.createdAt
});

const saveUser = (user) => {
  usersById.set(user.id, user);
  usersByEmail.set(user.email.toLowerCase(), user);
};

const loadUserByEmail = (email) => usersByEmail.get(email?.toLowerCase());

const assignAdvisor = (userId) => {
  if (advisorAssignments.has(userId)) {
    return advisorAssignments.get(userId);
  }
  const advisor = advisors[advisorAssignments.size % advisors.length];
  advisorAssignments.set(userId, advisor);
  advisorLogs.push({
    advisorId: advisor.id,
    userId,
    assignedAt: new Date().toISOString()
  });
  return advisor;
};

const initSeatMaps = () => {
  productions.forEach((production) => {
    production.performances.forEach((performance) => {
      const map = createSeatMap(
        performance.seatLayout.rows,
        performance.seatLayout.cols,
        performance.takenSeats || []
      );
      performanceSeatMaps.set(performance.id, map);
    });
  });
};

const findProductionById = (id) => productions.find((p) => p.id === id);
const findPerformanceById = (id) => {
  for (const production of productions) {
    const performance = production.performances.find((perf) => perf.id === id);
    if (performance) {
      return { production, performance };
    }
  }
  return null;
};

const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: `${TOKEN_TTL_HOURS}h` });

const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Missing authorization header' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = usersById.get(decoded.sub);
    if (!user) {
      return res.status(401).json({ message: 'User no longer exists' });
    }
    req.user = user;
    return next();
  } catch (error) {
    return res.status(401).json({ message: 'Invalid token' });
  }
};

const optionalAuth = (req, _res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return next();
  }
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = usersById.get(decoded.sub);
    if (user) {
      req.user = user;
    }
  } catch (error) {
    console.warn('Optional auth failed', error.message);
  }
  return next();
};

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ message: 'Admin privileges required' });
  }
  return next();
};

const seedAdmin = () => {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@goldcinema.test';
  if (loadUserByEmail(adminEmail)) {
    return;
  }
  const adminUser = {
    id: uuidv4(),
    customerId: 'ADMIN001',
    firstName: 'Admin',
    lastName: 'User',
    address: 'Admin HQ',
    city: 'Kisii',
    zipCode: '00000',
    mobile: '254700000000',
    email: adminEmail,
    passwordHash: bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'changeme', 10),
    role: 'admin',
    createdAt: new Date().toISOString()
  };
  saveUser(adminUser);
};

initSeatMaps();
seedAdmin();

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: MPESA_ENV
  });
});

app.get('/api/productions', (_req, res) => {
  const payload = productions.map((prod) => ({
    id: prod.id,
    name: prod.name,
    type: prod.type,
    genre: prod.genre,
    rating: prod.rating,
    durationMinutes: prod.durationMinutes,
    description: prod.description,
    poster: prod.poster,
    heroImage: prod.heroImage,
    performances: prod.performances.map((perf) => ({
      id: perf.id,
      date: perf.date,
      time: perf.time,
      venue: perf.venue,
      basePrice: perf.basePrice,
      ticketTypes: perf.ticketTypes
    }))
  }));
  res.json(payload);
});

app.get('/api/productions/:id', (req, res) => {
  const production = findProductionById(req.params.id);
  if (!production) {
    return res.status(404).json({ message: 'Production not found' });
  }
  return res.json(production);
});

app.get('/api/performances/:id/seats', (req, res) => {
  const seatMap = performanceSeatMaps.get(req.params.id);
  if (!seatMap) {
    return res.status(404).json({ message: 'Performance not found' });
  }
  return res.json(serializeSeatMap(seatMap));
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      firstName,
      lastName,
      address,
      city,
      zipCode,
      mobile,
      email,
      password
    } = req.body;

    if (!firstName || !lastName || !address || !city || !zipCode || !mobile || !email || !password) {
      return res.status(400).json({ message: 'Missing required fields' });
    }
    if (loadUserByEmail(email)) {
      return res.status(409).json({ message: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = {
      id: uuidv4(),
      customerId: generateCustomerId(),
      firstName,
      lastName,
      address,
      city,
      zipCode,
      mobile,
      email: email.toLowerCase(),
      passwordHash,
      role: 'customer',
      createdAt: new Date().toISOString()
    };
    saveUser(user);
    const advisor = assignAdvisor(user.id);
    const token = signToken({ sub: user.id, role: user.role });

    return res.status(201).json({
      token,
      user: { ...toUserResponse(user), advisor }
    });
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ message: 'Failed to register' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password required' });
  }
  const user = loadUserByEmail(email);
  if (!user) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  const valid = await bcrypt.compare(password, user.passwordHash);
  if (!valid) {
    return res.status(401).json({ message: 'Invalid credentials' });
  }
  const token = signToken({ sub: user.id, role: user.role });
  return res.json({ token, user: { ...toUserResponse(user), advisor: advisorAssignments.get(user.id) } });
});

app.get('/api/auth/profile', authenticate, (req, res) => {
  res.json({ user: { ...toUserResponse(req.user), advisor: advisorAssignments.get(req.user.id) } });
});

app.put('/api/auth/profile', authenticate, (req, res) => {
  const user = req.user;
  const { firstName, lastName, address, city, zipCode, mobile } = req.body;
  user.firstName = firstName || user.firstName;
  user.lastName = lastName || user.lastName;
  user.address = address || user.address;
  user.city = city || user.city;
  user.zipCode = zipCode || user.zipCode;
  user.mobile = mobile || user.mobile;
  saveUser(user);
  res.json({ user: toUserResponse(user) });
});

app.get('/api/auth/bookings', authenticate, (req, res) => {
  const bookings = [...bookingsStore.values()].filter((b) => b.userId === req.user.id);
  res.json(bookings);
});

const createBookingPayload = async (payload, user) => {
  const { performanceId, seats, ticketTypeId, paymentMethod, phone, name, email } = payload;
  if (!performanceId || !Array.isArray(seats) || seats.length === 0 || !ticketTypeId || !paymentMethod) {
    throw new Error('Missing booking fields');
  }
  const contactEmail = user?.email || email;
  const contactName = user ? `${user.firstName} ${user.lastName}`.trim() : name;
  if (!contactEmail || !contactName) {
    throw new Error('Contact name and email required');
  }
  if (paymentMethod === 'mpesa' && !phone) {
    throw new Error('M-Pesa phone number required');
  }
  const lookup = findPerformanceById(performanceId);
  if (!lookup) {
    throw new Error('Performance not found');
  }
  const { production, performance } = lookup;
  const ticketType = performance.ticketTypes.find((t) => t.id === ticketTypeId);
  if (!ticketType) {
    throw new Error('Ticket type not available');
  }
  const seatMap = performanceSeatMaps.get(performanceId);
  if (!seatMap) {
    throw new Error('Seat map not available');
  }
  if (!seatsAreAvailable(seatMap, seats)) {
    const unavailable = seats.filter((seat) => seatMap.seats.get(seat)?.status !== 'available');
    const err = new Error(`Seats unavailable: ${unavailable.join(', ')}`);
    err.code = 'SEATS_UNAVAILABLE';
    throw err;
  }

  const bookingId = uuidv4();
  const pricePerSeat = ticketType.price;
  const amount = pricePerSeat * seats.length;
  const phoneNumber = paymentMethod === 'mpesa' ? sanitizePhone(phone) : null;

  const booking = {
    bookingId,
    performanceId,
    productionId: production.id,
    productionName: production.name,
    performanceDate: performance.date,
    performanceTime: performance.time,
    venue: performance.venue,
    ticketType: ticketType.id,
    ticketLabel: ticketType.label,
    pricePerSeat,
    amount,
    seats,
    paymentMethod,
    status: paymentMethod === 'mpesa' ? 'pending_payment' : 'reserved',
    userId: user?.id || null,
    name: contactName,
    email: contactEmail,
    phone: phoneNumber,
    createdAt: new Date().toISOString()
  };

  holdSeats(seatMap, seats, bookingId);
  bookingsStore.set(bookingId, booking);
  return { booking, seatMap };
};

const handleBookingRequest = async (req, res) => {
  try {
    const { booking, seatMap } = await createBookingPayload(req.body, req.user);
    let stkResponse = null;
    if (booking.paymentMethod === 'mpesa') {
      try {
        const reference = booking.bookingId.split('-')[0].toUpperCase();
        stkResponse = await initiateStkPush({
          phone: booking.phone,
          amount: booking.amount,
          reference,
          description: `Booking ${reference} for ${booking.productionName}`
        });
        bookingsStore.set(booking.bookingId, {
          ...booking,
          checkoutRequestId: stkResponse.CheckoutRequestID,
          merchantRequestId: stkResponse.MerchantRequestID
        });
        const email = bookingPending({
          name: booking.name,
          bookingId: booking.bookingId,
          amount: booking.amount
        });
        await sendEmail({ to: booking.email, ...email });
      } catch (error) {
        console.error('STK error:', error.response?.data || error.message);
        releaseSeats(seatMap, booking.seats, booking.bookingId);
        bookingsStore.delete(booking.bookingId);
        return res.status(502).json({
          message: 'Failed to initiate M-Pesa payment',
          error: error.response?.data || error.message
        });
      }
    } else {
      finalizeSeats(seatMap, booking.seats, booking.bookingId);
      bookingsStore.set(booking.bookingId, { ...booking, status: 'paid', paymentReference: 'offline' });
    }

    return res.status(201).json({
      message:
        booking.paymentMethod === 'mpesa'
          ? 'Booking created. Approve the M-Pesa prompt.'
          : 'Booking confirmed.',
      bookingId: booking.bookingId,
      status: bookingsStore.get(booking.bookingId).status,
      checkoutRequestId: stkResponse?.CheckoutRequestID || null
    });
  } catch (error) {
    if (error.code === 'SEATS_UNAVAILABLE') {
      return res.status(409).json({ message: error.message });
    }
    console.error('Booking create error:', error);
    return res.status(400).json({ message: error.message || 'Failed to create booking' });
  }
};

app.post('/api/bookings', optionalAuth, handleBookingRequest);
app.post('/book', optionalAuth, handleBookingRequest);

app.get('/api/bookings/:id', (req, res) => {
  const booking = bookingsStore.get(req.params.id);
  if (!booking) {
    return res.status(404).json({ message: 'Booking not found' });
  }
  return res.json(booking);
});

app.post('/api/support/tickets', authenticate, (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ message: 'Message is required' });
  }
  const ticket = {
    id: `T${Date.now()}`,
    message,
    advisor: advisorAssignments.get(req.user.id) || assignAdvisor(req.user.id),
    status: 'open',
    createdAt: new Date().toISOString()
  };
  const existing = supportTickets.get(req.user.id) || [];
  existing.push(ticket);
  supportTickets.set(req.user.id, existing);
  advisorLogs.push({
    advisorId: ticket.advisor.id,
    userId: req.user.id,
    interaction: message,
    createdAt: ticket.createdAt
  });
  res.status(201).json(ticket);
});

app.get('/api/support/tickets', authenticate, (req, res) => {
  res.json(supportTickets.get(req.user.id) || []);
});

app.get('/api/admin/overview', authenticate, requireAdmin, (_req, res) => {
  const totalBookings = bookingsStore.size;
  const paidBookings = [...bookingsStore.values()].filter((b) => b.status === 'paid');
  const revenue = paidBookings.reduce((sum, booking) => sum + Number(booking.amount || 0), 0);
  res.json({
    totalBookings,
    paidBookings: paidBookings.length,
    revenue,
    customers: usersById.size,
    advisorAssignments: advisorLogs.length
  });
});

app.post(CALLBACK_PATH, (req, res) => {
  try {
    const callback = req.body?.Body?.stkCallback;
    if (!callback) {
      console.warn('Invalid callback payload received:', req.body);
      return res.status(400).json({ message: 'Invalid callback payload' });
    }

    const { ResultCode, ResultDesc, CheckoutRequestID, CallbackMetadata } = callback;

    const bookingEntry = [...bookingsStore.values()].find(
      (b) => b.checkoutRequestId === CheckoutRequestID
    );

    if (!bookingEntry) {
      console.warn('Callback for unknown booking', CheckoutRequestID);
    } else {
      const seatMap = performanceSeatMaps.get(bookingEntry.performanceId);
      if (ResultCode === 0) {
        const meta = {};
        CallbackMetadata?.Item?.forEach((item) => {
          meta[item.Name] = item.Value;
        });

        finalizeSeats(seatMap, bookingEntry.seats, bookingEntry.bookingId);
        const updated = {
          ...bookingEntry,
          status: 'paid',
          mpesaReceiptNumber: meta.MpesaReceiptNumber,
          amountPaid: meta.Amount,
          phone: meta.PhoneNumber || bookingEntry.phone,
          transactionDate: meta.TransactionDate,
          rawCallback: callback
        };
        bookingsStore.set(bookingEntry.bookingId, updated);
        const email = bookingConfirmation({
          name: bookingEntry.name,
          bookingId: bookingEntry.bookingId,
          performance: {
            productionName: bookingEntry.productionName,
            date: bookingEntry.performanceDate,
            time: bookingEntry.performanceTime,
            venue: bookingEntry.venue
          },
          seats: bookingEntry.seats,
          amount: bookingEntry.amount
        });
        sendEmail({ to: bookingEntry.email, ...email }).catch((err) =>
          console.error('Email send failed', err)
        );
      } else {
        releaseSeats(seatMap, bookingEntry.seats, bookingEntry.bookingId);
        bookingsStore.set(bookingEntry.bookingId, {
          ...bookingEntry,
          status: 'payment_failed',
          failureReason: ResultDesc,
          rawCallback: callback
        });
      }
    }

    res.json({ message: 'Callback received successfully' });
  } catch (error) {
    console.error('Callback handling error:', error);
    res.status(500).json({ message: 'Callback processing failed' });
  }
});

app.use((req, res) => {
  res.status(404).json({ message: 'Route not found' });
});

app.listen(PORT, () => {
  console.log(`✅ Gold Cinema backend listening on port ${PORT}`);
  console.log(`Callback URL: ${CALLBACK_URL}`);
});

