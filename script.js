const API = "https://kazuko-sloshier-morbifically.ngrok-free.dev"; 

document.addEventListener("DOMContentLoaded", () => {
  const eventsSection = document.getElementById("eventsSection");
  const eventSelect = document.getElementById("event");
  const ticketTypeSelect = document.getElementById("ticketType");
  const showtimeButtons = document.getElementById("showtimeButtons");
  const seatMap = document.getElementById("seatMap");
  const ticketsCount = document.getElementById("ticketsCount");
  const ticketPrice = document.getElementById("ticketPrice");
  const totalAmount = document.getElementById("totalAmount");
  const eticketModal = document.getElementById("eticketModal");

  let events = [];
  let selectedEvent = null;
  let selectedShowtime = null;
  let selectedSeats = new Set();
  let currentPrice = 0;
  let currentBookingRef = null;
  document.getElementById("bookingForm").onsubmit = async e => {
  e.preventDefault();
  const name = document.getElementById("name").value.trim();
  const email = document.getElementById("email").value.trim();
  const mobile = document.getElementById("mobile").value.trim();

  // Validate name
  if (!/^[A-Za-z\s]+$/.test(name)) {
    return alert("Name must contain only letters.");
  }

  // Validate email
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return alert("Enter a valid email address.");
  }

  // Validate mobile (Kenyan format)
  if (!/^2547\d{8}$/.test(mobile)) {
    return alert("Enter a valid Kenyan mobile number (e.g. 254712345678).");
  }

  if (selectedSeats.size === 0) {
    return alert("Please select at least one seat.");
  }

  // If all good → send to backend
  const holdRes = await fetch(`${API}/api/bookings/hold`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({
      production_id: selectedEvent.id,
      showtime: selectedShowtime,
      seat_ids: Array.from(selectedSeats),
      ticket_type: ticketTypeSelect.options[ticketTypeSelect.selectedIndex].text,
      price: currentPrice,
      name, email, mobile
    })
  }).then(r => r.json());

  if (holdRes.error) return alert(holdRes.error);

  // Trigger STK Push
  const stkRes = await fetch(`${API}/api/payments/stkpush`, {
    method: "POST",
    headers: {"Content-Type":"application/json"},
    body: JSON.stringify({ booking_ref: holdRes.ref, mobile })
  }).then(r => r.json());

  if (stkRes.error) return alert(stkRes.error);
  alert(stkRes.message || "Check your phone to complete payment.");
};
async function renderSeatMap(productionId) {
  const seats = await fetch(`${API}/api/seats/${productionId}`).then(r => r.json());
  seatMap.innerHTML = "";
  seats.forEach(s => {
    const div = document.createElement("div");
    div.className = "seat" + (s.status === 2 ? " taken" : "");
    div.textContent = `${s.row}${s.number}`;
    div.dataset.id = s.id;
    if (s.status !== 2) {
      div.onclick = () => {
        if (selectedSeats.has(s.id)) {
          selectedSeats.delete(s.id);
          div.classList.remove("selected");
        } else {
          selectedSeats.add(s.id);
          div.classList.add("selected");
        }
        updateSummary();
      };
    }
    seatMap.appendChild(div);
  });
}

  // Load events
  fetch(`${API}/api/events`)
    .then(r => r.json())
    .then(data => {
      events = data;
      renderEvents();
      populateEventSelect();
    });

  function renderEvents() {
    eventsSection.innerHTML = events.map(ev => `
      <div class="event-card" data-id="${ev.id}">
        <h3>${ev.name} — ${ev.type}</h3>
        <p>${ev.date}</p>
        <div class="meta">Showtimes: ${ev.showtimes.join(", ")}</div>
      </div>
    `).join("");

    eventsSection.querySelectorAll(".event-card").forEach(card => {
      card.onclick = () => {
        eventSelect.value = card.dataset.id;
        eventSelect.dispatchEvent(new Event("change"));
        document.getElementById("tabBook").click();
      };
    });
  }

  function populateEventSelect() {
    eventSelect.innerHTML = events.map(ev => `<option value="${ev.id}">${ev.name}</option>`).join("");
    eventSelect.dispatchEvent(new Event("change"));
  }

  eventSelect.onchange = async () => {
    selectedEvent = events.find(ev => ev.id == eventSelect.value);

    ticketTypeSelect.innerHTML = Object.entries(selectedEvent.ticketTypes)
      .map(([k,v]) => `<option value="${v}">${k} — KSh ${v}</option>`).join("");
    currentPrice = parseInt(ticketTypeSelect.value, 10);

    showtimeButtons.innerHTML = selectedEvent.showtimes
      .map(t => `<button class="btn secondary" type="button" data-time="${t}">${t}</button>`).join("");
    showtimeButtons.querySelectorAll("button").forEach(btn => {
      btn.onclick = () => {
        selectedShowtime = btn.dataset.time;
        showtimeButtons.querySelectorAll("button").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
      };
    });

    // load seats
    const seats = await fetch(`${API}/api/seats/${selectedEvent.id}`).then(r => r.json());
    seatMap.innerHTML = "";
    seats.forEach(s => {
      const div = document.createElement("div");
      div.className = "seat" + (s.status === 2 ? " taken" : "");
      div.textContent = `${s.row}${s.number}`;
      div.dataset.id = s.id;
      if (s.status !== 2) {
        div.onclick = () => {
          const id = String(s.id);
          if (selectedSeats.has(id)) {
            selectedSeats.delete(id); div.classList.remove("selected");
          } else {
            selectedSeats.add(id); div.classList.add("selected");
          }
          updateSummary();
        };
      }
      seatMap.appendChild(div);
    });
  };

  ticketTypeSelect.onchange = e => {
    currentPrice = parseInt(e.target.value, 10);
    updateSummary();
  };

  function updateSummary() {
    const count = selectedSeats.size;
    ticketsCount.textContent = count;
    ticketPrice.textContent = `KSh ${currentPrice}`;
    totalAmount.textContent = `KSh ${count * currentPrice}`;
  }

  // Booking form submit
  document.getElementById("bookingForm").onsubmit = async e => {
    e.preventDefault();
    const name = document.getElementById("name").value.trim();
    const email = document.getElementById("email").value.trim();
    const mobile = prompt("Enter your M-Pesa number (2547XXXXXXXX):");

    if (!selectedEvent || !selectedShowtime || selectedSeats.size === 0 || !name || !email || !mobile) {
      return alert("Please complete all fields and select seats.");
    }

    // 1) Hold seats
    const holdRes = await fetch(`${API}/api/bookings/hold`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({
        production_id: selectedEvent.id,
        showtime: selectedShowtime,
        seat_ids: Array.from(selectedSeats),
        ticket_type: ticketTypeSelect.options[ticketTypeSelect.selectedIndex].text,
        price: currentPrice,
        name, email, mobile
      })
    }).then(r => r.json());

    if (holdRes.error) return alert(holdRes.error);
    currentBookingRef = holdRes.ref;

    // 2) Trigger STK Push
    const stkRes = await fetch(`${API}/api/payments/stkpush`, {
      method: "POST",
      headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ booking_ref: currentBookingRef, mobile })
    }).then(r => r.json());

    if (stkRes.error) return alert(stkRes.error);
    alert(stkRes.message || "Check your phone to complete payment.");

    // 3) Poll status
    pollStatus(currentBookingRef);
  };

  async function pollStatus(ref) {
    const interval = setInterval(async () => {
      const res = await fetch(`${API}/api/bookings/status/${ref}`).then(r => r.json());
      if (res.status === "paid") {
        clearInterval(interval);
        showETicketModal(ref);
      } else if (res.status === "failed") {
        clearInterval(interval);
        alert("Payment failed. Seats released.");
      }
    }, 3000);
  }

  function showETicketModal(ref) {
    eticketModal.style.display = "flex";
    eticketModal.innerHTML = `
      <div style="background:#0b1220;padding:24px;border-radius:12px;max-width:520px">
        <h3>Payment successful 🎟️</h3>
        <p>Your booking ref <strong>${ref}</strong> is confirmed. Check your email for the e‑ticket PDF.</p>
        <button class="btn" id="closeTicket">Close</button>
      </div>
    `;
    document.getElementById("closeTicket").onclick = () => (eticketModal.style.display = "none");
  }
});