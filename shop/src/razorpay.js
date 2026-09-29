/**
 * Razorpay's own checkout, opened over the shop page.
 *
 * Card numbers and UPI PINs are typed into Razorpay's frame, never into this page (rule P3): what
 * comes back to us is only an order id, a payment id and Razorpay's signature over them. And even
 * that is not taken as proof of anything -- it is handed to the shop, which asks Razorpay itself.
 *
 * The script is fetched only when somebody actually presses Pay, and once. A shopper browsing
 * sarees downloads none of it.
 */
const SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let loading = null;

function load() {
  if (typeof window !== 'undefined' && window.Razorpay) return Promise.resolve(window.Razorpay);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SRC;
    s.async = true;
    s.onload = () => (window.Razorpay ? resolve(window.Razorpay) : reject(new Error('unavailable')));
    s.onerror = () => { loading = null; reject(new Error('unavailable')); };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Open the checkout and wait for the customer.
 *
 * Resolves with Razorpay's handback when they pay. Rejects with { dismissed: true } when they close
 * it without paying, and with { unavailable: true } when Razorpay's page could not be loaded at all
 * -- two different things to say to somebody: "nothing was charged, try again" and "the payment
 * page will not open on this connection".
 */
export async function openCheckout(options) {
  let Razorpay;
  try { Razorpay = await load(); } catch { throw { unavailable: true }; }

  return new Promise((resolve, reject) => {
    let settled = false;
    const rz = new Razorpay({
      ...options,
      handler: (handback) => { settled = true; resolve(handback); },
      modal: {
        // Asked before closing, because a UPI app that was switched to and back from can look like
        // an accidental tap on the close button, and closing then is how a payment gets abandoned.
        confirm_close: true,
        ondismiss: () => { if (!settled) reject({ dismissed: true }); }
      }
    });
    // A failed attempt inside the checkout is not the end: Razorpay lets them try another card or
    // UPI app in the same window (retry is on), so nothing is rejected here. The shop keeps the
    // failure reason and the payment page shows it if they close.
    rz.on?.('payment.failed', () => {});
    rz.open();
  });
}
