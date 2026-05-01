Titchybook Print + Ship Ordering System

Build a full-stack feature that enables users to order printed, folded, and shipped Titchybooks directly from the platform.

The system must integrate with the existing Titchybook designer (which outputs a print-ready PDF) and add:

Order quantity selection
Automated shipping cost calculation (based on Magyar Posta weight bands)
Dynamic price-per-copy logic
Total order pricing (print + handling + shipping)
Checkout-ready structure
CORE PRODUCT CONSTRAINTS
1 Titchybook = 6 grams
Orders are shipped as letters via Magyar Posta
Pricing is based on weight bands
Max shipment weight = 2000g
WEIGHT BANDS (FIXED LOGIC)

Use these exact bands:

[
  { "maxWeight": 50 },
  { "maxWeight": 100 },
  { "maxWeight": 250 },
  { "maxWeight": 500 },
  { "maxWeight": 1000 },
  { "maxWeight": 2000 }
]
SHIPPING ZONES

Define 5 zones:

["hungary", "eu", "uk", "usa", "rest_of_world"]
SHIPPING PRICE TABLE (HUF)

Use this as the base configuration:

{
  "hungary": [270, 305, 365, 540, 845, 1630],
  "eu": [1250, 1600, 2200, 3600, 6000, 10000],
  "uk": [1300, 1650, 2300, 3700, 6200, 10200],
  "usa": [1550, 2000, 3000, 5000, 8500, 14000],
  "rest_of_world": [1550, 2000, 3000, 5000, 8500, 14000]
}

Index corresponds to weight bands.

CORE LOGIC FUNCTIONS
1. Calculate shipment weight
function calculateWeight(quantity) {
  return quantity * 6;
}
2. Determine weight band
function getWeightBand(weight) {
  const bands = [50, 100, 250, 500, 1000, 2000];
  return bands.findIndex(b => weight <= b);
}
3. Get shipping price
function getShippingCost(zone, quantity) {
  const weight = calculateWeight(quantity);
  const bandIndex = getWeightBand(weight);
  return SHIPPING_TABLE[zone][bandIndex];
}
4. Price-per-copy logic (dynamic tiers)

Allow admin-configurable pricing tiers:

[
  { "min": 1, "max": 8, "pricePerCopy": 300 },
  { "min": 9, "max": 40, "pricePerCopy": 180 },
  { "min": 41, "max": 80, "pricePerCopy": 120 },
  { "min": 81, "max": 160, "pricePerCopy": 90 },
  { "min": 161, "max": 333, "pricePerCopy": 70 }
]
5. Get unit price
function getUnitPrice(quantity) {
  return PRICE_TIERS.find(t => quantity >= t.min && quantity <= t.max).pricePerCopy;
}
6. Full order calculation
function calculateOrder(zone, quantity) {
  const unitPrice = getUnitPrice(quantity);
  const printCost = unitPrice * quantity;
  const shipping = getShippingCost(zone, quantity);

  return {
    quantity,
    unitPrice,
    printCost,
    shipping,
    total: printCost + shipping,
    costPerBook: (printCost + shipping) / quantity
  };
}
UX REQUIREMENTS
Order Panel (on Titchybook editor page)

Include:

Quantity selector (slider + manual input)
Shipping destination dropdown
Real-time pricing display:

Show:

Price per copy
Print cost
Shipping cost
Total cost
Effective cost per book

Update instantly when:

Quantity changes
Destination changes
Smart UX Enhancements (IMPORTANT)

Highlight optimal price breaks:

8 books (50g cap)
40 books (250g sweet spot)
80 books (500g)

Display messages like:

“Best value: 40 copies reduces shipping cost per book by 60%”
“You are near the next price break”
ADMIN PANEL REQUIREMENTS

Allow admin to:

Edit shipping price table
Edit price-per-copy tiers
Add handling fee (fixed or %)
Enable/disable zones
Adjust weight per book (future-proofing)
ORDER OBJECT STRUCTURE
{
  "userId": "",
  "titchybookId": "",
  "quantity": 40,
  "zone": "eu",
  "weight": 240,
  "shippingBand": 2,
  "unitPrice": 180,
  "printCost": 7200,
  "shippingCost": 2200,
  "total": 9400,
  "status": "pending",
  "createdAt": ""
}
FUTURE-PROOFING (BUILD THIS CLEANLY)

Design system so it can later support:

Multiple shipments (split orders over 2kg)
Print location hubs (EU / US local fulfilment)
Bulk discounts per user
Coupon codes
Subscription printing (monthly batches)
Crowd-funded batch printing (multiple users sharing one shipment)
OPTIONAL ADVANCED FEATURE (HIGH VALUE)

Add “Batch Optimisation Engine”:

Suggest optimal quantity for lowest cost per book
Auto-round orders to most efficient band

Example:

“Order 40 instead of 32 for 22% lower cost per unit”

TECH NOTES
Keep pricing logic server-side (authoritative)
Mirror calculations client-side for UX speed
All pricing values configurable via DB (not hardcoded)
Currency: HUF (prepare for multi-currency later)
OUTPUT EXPECTATION

Qoder should generate:

Frontend order UI component
Backend pricing engine
API endpoint: /calculate-order
API endpoint: /create-order
Admin config interface
Database schema for orders + pricing