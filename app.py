from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import datetime
import smtplib
import uuid
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
import os
from dotenv import load_dotenv
import base64
from bs4 import BeautifulSoup

load_dotenv()

app = Flask(__name__)
CORS(app)

# ✅ CONFIGURATION
DARAJA_CONSUMER_KEY = os.getenv("DARAJA_CONSUMER_KEY", "FYDGIEuCqS8fQB1m0JjewGnGfH1xDqeCte3myM1CYz9IsgHR")
DARAJA_CONSUMER_SECRET = os.getenv("DARAJA_CONSUMER_SECRET", "50o2I8Rll0yfShgcYIOb3gquX9wNZFs6YJEfRu9tqG194qhcW3jepD9dEfjGymU9")
DARAJA_BUSINESS_SHORTCODE = os.getenv("DARAJA_BUSINESS_SHORTCODE", "174379")
DARAJA_PASSKEY = os.getenv("DARAJA_PASSKEY", "b7BntFzEKYMhu6Cdd5b9srIjXDf8wqs84Go+XsDprjyNOXSClyVT1LwkBsh4vLHmBz+5S0+hxfST+R/d08GbSfUeoEmQPjpe98HaMdX3YlGF+pmAIWv+KzXJPJeqRe/sz1aUATnr4ZKFugnz/ZU/aYX9eNuvC3fuaAEd+y6zSd/fJ1e3l/H1n+rKQEUrmdgBOtGEMXbydgWOI843u7zTTz8r0Rk+r5WNtLJvCx5vj/bQhA2NDg5iyasDx2e4H0sDBGf+WeRBG1TRj4aRKGv3Y8WXMgqHtV4/kh+ukrg4mTVy5U3AtSUxbKjfkc7ArlS+wTxES8AdU4drB9gUWceNIQ==")
SENDER_EMAIL = os.getenv("SENDER_EMAIL", "amoohmike@gmail.com")
SENDER_PASSWORD = os.getenv("SENDER_PASSWORD", "plcdskxwexewfbgx")

# ✅ PAYMENT MODES
PAYMENT_MODES = {
    "mpesa": {"name": "M-Pesa", "icon": "📱", "description": "Pay via M-Pesa"},
    "card": {"name": "Credit/Debit Card", "icon": "💳", "description": "Visa, Mastercard"},
    "bank": {"name": "Bank Transfer", "icon": "🏦", "description": "Direct Bank Transfer"},
    "airtel": {"name": "Airtel Money", "icon": "📲", "description": "Airtel Money Wallet"}
}

# ✅ GET DARAJA ACCESS TOKEN ROUTE
@app.route("/api/token", methods=["GET"])
def get_access_token():
    """Get access token from Daraja API"""
    url = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"
    auth = base64.b64encode(f"{DARAJA_CONSUMER_KEY}:{DARAJA_CONSUMER_SECRET}".encode()).decode()
    headers = {
        "Authorization": f"Basic {auth}"
    }
    
    try:
        res = requests.get(url, headers=headers, timeout=10)
        if res.ok:
            return jsonify(res.json()), 200
        else:
            return jsonify({"error": res.text}), res.status_code
    except requests.exceptions.RequestException as e:
        return jsonify({"error": str(e)}), 500

# ✅ STK PUSH ROUTE
@app.route("/api/stkpush", methods=["POST"])
def stk_push():
    """Initiate M-Pesa STK Push"""
    data = request.json
    phone = data.get("phone")
    amount = data.get("amount")
    reference = data.get("reference", "Ticket Payment")

    if not all([phone, amount]):
        return jsonify({"error": "Missing required fields"}), 400

    access_token = get_daraja_access_token()
    if not access_token:
        return jsonify({"error": "Failed to get access token"}), 500

    url = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }

    timestamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    password = base64.b64encode(f"{DARAJA_BUSINESS_SHORTCODE}{DARAJA_PASSKEY}{timestamp}".encode()).decode()

    payload = {
        "BusinessShortCode": DARAJA_BUSINESS_SHORTCODE,
        "Password": password,
        "Timestamp": timestamp,
        "TransactionType": "CustomerPayBillOnline",
        "Amount": int(amount),
        "PartyA": phone,
        "PartyB": DARAJA_BUSINESS_SHORTCODE,
        "PhoneNumber": phone,
        "CallBackURL": "https://yourdomain.com/api/payment/callback",
        "AccountReference": reference,
        "TransactionDesc": "Gold Cinema Ticket Payment"
    }

    try:
        res = requests.post(url, json=payload, headers=headers, timeout=10)
        return jsonify(res.json()), res.status_code
    except requests.exceptions.RequestException as e:
        return jsonify({"error": str(e)}), 500

# ✅ PAYMENT CALLBACK ROUTE
@app.route("/api/payment/callback", methods=["POST"])
def payment_callback():
    """Handle Daraja callback"""
    data = request.json
    print(f"📥 Callback: {data}")

    amount = data.get("Amount")
    phone = data.get("PhoneNumber")
    receipt_number = data.get("MpesaReceiptNumber")
    result_code = data.get("ResultCode")

    return jsonify({
        "amount": amount,
        "phone": phone,
        "receipt_number": receipt_number,
        "result_code": result_code,
        "status": "Success" if result_code == "0" else "Failed"
    }), 200

# ✅ PRICING
PRICING = {
    "VIP": {"rows": ["A", "B"], "price": 1200},
    "REGULAR": {"rows": ["C", "D", "E", "F"], "price": 700},
    "ECONOMY": {"rows": ["G", "H"], "price": 350}
}

# ✅ MOCK EVENTS DATABASE
EVENTS = {}

def load_events_from_html():
    """Load events from events.html file."""

    try:
        with open("event.html", "r") as file:
            soup = BeautifulSoup(file, "html.parser")
            for event in soup.find_all("event"):
                event_id = event.get("id")
                title = event.find("title").text
                date = event.find("date").text
                time = event.find("time").text
                venue = event.find("venue").text
                image_url = event.find("image_url").text
                
                # Ensure the event date is in the future
                if datetime.datetime.strptime(date, "%Y-%m-%d") > datetime.datetime.now():
                    EVENTS[event_id] = {
                        "title": title,
                        "date": date,
                        "time": time,
                        "venue": venue,
                        "image_url": image_url
                    }
    except FileNotFoundError:
        print("⚠️ event.html not found. Skipping event loading.")
        return
    except Exception as e:
        print(f"⚠️ Error loading events: {e}")
        return

load_events_from_html()

# ✅ GET DARAJA ACCESS TOKEN
def get_daraja_access_token():
    """Get access token from Daraja API"""
    url = "https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials"
    auth = base64.b64encode(f"{DARAJA_CONSUMER_KEY}:{DARAJA_CONSUMER_SECRET}".encode()).decode()
    headers = {
        "Authorization": f"Basic {auth}"
    }
    
    try:
        res = requests.get(url, headers=headers, timeout=10)
        if res.ok:
            return res.json()["access_token"]
        else:
            print(f"❌ Token Error: {res.text}")
            return None
    except requests.exceptions.RequestException as e:
        print(f"❌ Token Request Error: {e}")
        return None

# ✅ INITIATE STK PUSH (DARAJA)
def initiate_stk_push(phone, amount, reference):
    """Initiate M-Pesa STK Push via Daraja"""
    access_token = get_daraja_access_token()
    if not access_token:
        return {"error": "Failed to get access token"}
    
    url = "https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest"
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Content-Type": "application/json"
    }
    
    timestamp = datetime.datetime.now().strftime("%Y%m%d%H%M%S")
    password = base64.b64encode(f"{DARAJA_BUSINESS_SHORTCODE}{DARAJA_PASSKEY}{timestamp}".encode()).decode()
    
    payload = {
        "BusinessShortCode": DARAJA_BUSINESS_SHORTCODE,
        "Password": password,
        "Timestamp": timestamp,
        "TransactionType": "CustomerPayBillOnline",
        "Amount": int(amount),
        "PartyA": phone,
        "PartyB": DARAJA_BUSINESS_SHORTCODE,
        "PhoneNumber": phone,
        "CallBackURL": "https://yourdomain.com/api/payment/callback",
        "AccountReference": reference,
        "TransactionDesc": "Gold Cinema Ticket Payment"
    }

    try:
        res = requests.post(url, json=payload, headers=headers, timeout=10)
        print(f"📡 STK Push Response: {res.status_code}")
        return res.json() if res.ok else {"error": res.text, "status": res.status_code}
    except requests.exceptions.RequestException as e:
        print(f"❌ STK Push Error: {e}")
        return {"error": str(e)}

# ✅ GET EVENT DETAILS
def get_event_details(event_id):
    """Fetch event from database or return default"""
    return EVENTS.get(event_id, {
        "title": "Gold Cinema Event",
        "date": datetime.datetime.now().strftime("%Y-%m-%d"),
        "time": "19:00",
        "venue": "Gold Cinema",
        "image_url": ""
    })

# ✅ CALCULATE TICKET PRICE
def calculate_amount(seats):
    """Calculate total amount based on seat rows"""
    amount = 0
    for seat in seats:
        row = seat[0].upper()
        for data in PRICING.values():
            if row in data["rows"]:
                amount += data["price"]
                break
    return amount

# ✅ SEND TICKET EMAIL
def send_ticket_email(to_email, phone, tickets, amount, seats, ticket_id, event, payment_mode):
    """Send professional ticket confirmation email"""
    payment_info = PAYMENT_MODES.get(payment_mode, PAYMENT_MODES["mpesa"])
    subject = f"🎬 Your Gold Cinema Ticket - {event['title']} (Confirmation)"
    now = datetime.datetime.now().strftime("%m/%d/%Y %I:%M %p")
    event_date = event.get("date", "TBA")
    event_time = event.get("time", "TBA")

    payment_badge_html = f"""
    <div class="payment-info">
        <strong>💳 Payment Method:</strong> {payment_info['icon']} {payment_info['name']}<br>
        <strong>Description:</strong> {payment_info['description']}
    </div>
    """

    html = f"""
    <html>
    <head>
        <style>
            body {{ background: #0f0f0f; color: #e0e0e0; font-family: 'Segoe UI', Arial; }}
            .container {{ max-width: 650px; margin: 0 auto; background: #1a1a1a; border-radius: 15px; padding: 30px; border: 2px solid #d4af37; box-shadow: 0 8px 20px rgba(212, 175, 55, 0.2); }}
            .header {{ text-align: center; margin-bottom: 30px; }}
            .header h1 {{ color: #d4af37; font-size: 28px; margin: 0; text-shadow: 0 0 10px rgba(212, 175, 55, 0.3); }}
            .header p {{ color: #888; margin: 5px 0 0 0; }}
            .booking-id {{ background: #0f0f0f; padding: 15px; border-radius: 10px; border-left: 4px solid #d4af37; margin: 20px 0; text-align: center; }}
            .booking-id strong {{ color: #d4af37; font-size: 18px; }}
            .details-table {{ width: 100%; margin: 20px 0; border-collapse: collapse; }}
            .details-table tr {{ border-bottom: 1px solid #333; }}
            .details-table td {{ padding: 12px; }}
            .details-table td:first-child {{ color: #d4af37; font-weight: bold; width: 35%; }}
            .event-card {{ background: #252525; border: 1px solid #444; border-radius: 10px; padding: 20px; margin: 20px 0; }}
            .event-card h3 {{ color: #d4af37; margin: 0 0 10px 0; }}
            .payment-badge {{ background: #1d5d1d; color: #4ade80; padding: 10px 15px; border-radius: 8px; text-align: center; margin: 20px 0; font-weight: bold; }}
            .payment-info {{ background: #252525; border: 1px solid #d4af37; border-radius: 10px; padding: 15px; margin: 20px 0; color: #e0e0e0; }}
            .footer {{ text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #333; color: #888; font-size: 12px; }}
            .footer a {{ color: #d4af37; text-decoration: none; }}
        </style>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🎬 Booking Confirmed!</h1>
                <p>Your tickets are ready</p>
            </div>

            <div class="booking-id">
                <strong>Booking ID: {ticket_id}</strong>
            </div>

            <div class="event-card">
                <h3>{event['title']}</h3>
                <table class="details-table">
                    <tr>
                        <td>📅 Date</td>
                        <td>{event_date}</td>
                    </tr>
                    <tr>
                        <td>🕐 Time</td>
                        <td>{event_time}</td>
                    </tr>
                    <tr>
                        <td>📍 Venue</td>
                        <td>{event.get('venue', 'Gold Cinema')}</td>
                    </tr>
                </table>
            </div>

            <table class="details-table">
                <tr>
                    <td>👤 Guest</td>
                    <td>{to_email}</td>
                </tr>
                <tr>
                    <td>📞 Phone</td>
                    <td>{phone}</td>
                </tr>
                <tr>
                    <td>🎫 Tickets</td>
                    <td>{tickets}</td>
                </tr>
                <tr>
                    <td>💺 Seats</td>
                    <td><strong>{", ".join(seats)}</strong></td>
                </tr>
                <tr>
                    <td>💰 Amount</td>
                    <td><strong style="color: #d4af37;">Ksh. {amount:,}</strong></td>
                </tr>
                <tr>
                    <td>⏱️ Booked At</td>
                    <td>{now}</td>
                </tr>
            </table>

            {payment_badge_html}
            <div class="payment-badge">✅ Payment Status: Pending Confirmation</div>

            <div class="footer">
                <p>For support, contact us: <a href="mailto:{SENDER_EMAIL}">{SENDER_EMAIL}</a></p>
                <p><strong>Gold Cinema</strong> – Elevate Your Movie Experience!</p>
                <p style="color: #666; margin-top: 15px;">This is an automated message. Please do not reply to this email.</p>
            </div>
        </div>
    </body>
    </html>
    """

    msg = MIMEMultipart("alternative")
    msg["From"] = SENDER_EMAIL
    msg["To"] = to_email
    msg["Subject"] = subject
    msg.attach(MIMEText(html, "html"))

    try:
        server = smtplib.SMTP("smtp.gmail.com", 587)
        server.starttls()
        server.login(SENDER_EMAIL, SENDER_PASSWORD)
        server.sendmail(SENDER_EMAIL, to_email, msg.as_string())
        server.quit()
        print("✅ Email sent successfully")
        return True
    except Exception as e:
        print(f"❌ Email failed: {e}")
        return False

# ✅ BOOK TICKET ENDPOINT
@app.route("/api/book", methods=["POST"])
@app.route("/book", methods=["POST"])
def book_ticket():
    """Handle ticket booking"""
    try:
        data = request.json
        email = data.get("email")
        phone = data.get("phone")
        seats = data.get("seats", [])
        event_id = data.get("event_id", "gold-cinema-001")
        payment_mode = data.get("payment_mode", "mpesa")

        # ✅ Validation
        if not all([email, phone, seats]):
            return jsonify({"error": "Missing required fields"}), 400

        # ✅ Validate payment mode
        if payment_mode not in PAYMENT_MODES:
            return jsonify({"error": f"Invalid payment mode. Allowed: {list(PAYMENT_MODES.keys())}"}), 400

        # ✅ Phone format validation (Kenya)
        if not phone.startswith("254"):
            phone = "254" + phone.lstrip("0")

        # ✅ Calculate amount
        amount = calculate_amount(seats)
        if amount <= 0:
            return jsonify({"error": "Invalid seat selection"}), 400

        # ✅ Get event details
        event = get_event_details(event_id)

        # ✅ Generate ticket ID
        ticket_id = str(uuid.uuid4().int)[:15]

        # ✅ Send email
        email_sent = send_ticket_email(email, phone, len(seats), amount, seats, ticket_id, event, payment_mode)

        # ✅ Initiate payment based on mode
        payment_response = {}
        if payment_mode == "mpesa":
            payment_response = initiate_stk_push(phone, amount, ticket_id)
        else:
            payment_response = {"status": "pending", "message": f"Please proceed with {PAYMENT_MODES[payment_mode]['name']} payment"}

        return jsonify({
            "success": True,
            "message": "Booking successful! Check your email for ticket details.",
            "ticket_id": ticket_id,
            "amount": amount,
            "event": event,
            "payment_mode": payment_mode,
            "payment_info": PAYMENT_MODES[payment_mode],
            "email_sent": email_sent,
            "payment_response": payment_response
        }), 201

    except Exception as e:
        print(f"❌ Booking error: {e}")
        return jsonify({"error": str(e)}), 500

# ✅ GET PAYMENT MODES ENDPOINT
@app.route("/api/payment-modes", methods=["GET"])
def get_payment_modes():
    """Return all available payment modes"""
    return jsonify(PAYMENT_MODES), 200

# ✅ GET EVENTS ENDPOINT
@app.route("/api/events", methods=["GET"])
def get_events():
    """Return all available events"""
    return jsonify(list(EVENTS.values())), 200

# ✅ HEALTH CHECK
@app.route("/api/health", methods=["GET"])
def health():
    return {"status": "🟢 Server running"}, 200

# ✅ RUN APP
if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)