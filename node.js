// views/emailTemplate.js
const generateBookingEmail = ({ name, email, bookingId, event, time }) => {
    return {
        subject: `New booking from ${name} on ${time}`,
        html: `
            <div style="font-family: Arial, sans-serif; padding: 20px;">
                <h2 style="color: #333;">🎟️ New Booking Notification</h2>
                <p><strong>Booking ID:</strong> ${bookingId}</p>
                <p><strong>Event:</strong> ${event}</p>
                <p><strong>Time:</strong> ${time}</p>
                <p><strong>Attendee:</strong> ${email} (${name})</p>
                <br>
                <p style="font-style: italic; color: #555;">Cheer! Booking Scheduling Bot</p>
                <hr>
                <small>You’re receiving this email because you made a booking on Gold Cinema.</small>
            </div>
        `
    };
};

module.exports = generateBookingEmail;