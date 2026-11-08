import { addDays, addMonths } from './domain.js';

// Sample household, with dates anchored to "today" so every status is represented.
export function demoInventory(today) {
  const ago = (days) => addDays(today, -days);
  const after = (months, from) => addMonths(from, months);
  const items = [
    {
      name: 'Bosch 800 Series Dishwasher', category: 'Appliances', brand: 'Bosch', model: 'SHX78CM5N',
      serial_number: 'FD9907-118234', location: 'Kitchen', retailer: 'Best Buy',
      purchase_date: ago(355), price_cents: 114900, life_months: 120,
      notes: 'Installed by Metro Plumbing. Filter cleaned every 3 months.',
      coverages: (p) => [
        { label: 'Manufacturer warranty', provider: 'Bosch', starts_on: p, expires_on: after(12, p) },
        { label: 'Stainless tub and racks', provider: 'Bosch', starts_on: p, expires_on: after(60, p), notes: 'Parts only, labor not covered.' },
      ],
    },
    {
      name: 'MacBook Pro 14"', category: 'Electronics', brand: 'Apple', model: 'M4 Pro, 24GB',
      serial_number: 'C02FK3XQMD6R', location: 'Office', retailer: 'Apple Store',
      purchase_date: ago(300), price_cents: 199900, life_months: 36,
      coverages: (p) => [
        { label: 'AppleCare+', provider: 'Apple', starts_on: p, expires_on: after(36, p), notes: 'Accidental damage: 2 incidents per year.' },
      ],
    },
    {
      name: 'LG OLED evo C4 65"', category: 'Electronics', brand: 'LG', model: 'OLED65C4PUA',
      serial_number: '404RMSJ7A112', location: 'Living Room', retailer: 'Costco',
      purchase_date: ago(720), price_cents: 179999, life_months: 84,
      coverages: (p) => [
        { label: 'Manufacturer warranty', provider: 'LG', starts_on: p, expires_on: after(12, p) },
        { label: 'Costco Concierge extension', provider: 'Costco', starts_on: after(12, p), expires_on: addDays(today, 18) },
      ],
    },
    {
      name: 'Carrier Infinity Heat Pump', category: 'HVAC', brand: 'Carrier', model: '25VNA4',
      serial_number: '2219E44871', location: 'Exterior', retailer: 'Comfort Air Co.',
      purchase_date: ago(1460), price_cents: 1120000, life_months: 180,
      notes: 'Registered within 90 days for 10-year parts coverage. Annual service each April.',
      coverages: (p) => [
        { label: 'Labor warranty', provider: 'Comfort Air Co.', starts_on: p, expires_on: after(24, p) },
        { label: 'Parts warranty', provider: 'Carrier', starts_on: p, expires_on: after(120, p) },
        { label: 'Compressor', provider: 'Carrier', starts_on: p, expires_on: after(144, p) },
      ],
    },
    {
      name: 'Dyson V15 Detect', category: 'Appliances', brand: 'Dyson', model: 'SV22',
      serial_number: 'SV22-US-NKA4419', location: 'Hall Closet', retailer: 'Dyson',
      purchase_date: ago(745), price_cents: 74999, life_months: 60,
      coverages: (p) => [
        { label: 'Manufacturer warranty', provider: 'Dyson', starts_on: p, expires_on: after(24, p) },
      ],
    },
    {
      name: 'Herman Miller Aeron', category: 'Furniture', brand: 'Herman Miller', model: 'Size B, Graphite',
      serial_number: 'HM-AER-B-77120', location: 'Office', retailer: 'Design Within Reach',
      purchase_date: ago(530), price_cents: 180500, life_months: 144,
      coverages: (p) => [
        { label: '12-year warranty', provider: 'Herman Miller', starts_on: p, expires_on: after(144, p) },
      ],
    },
    {
      name: 'Samsung Bespoke Refrigerator', category: 'Appliances', brand: 'Samsung', model: 'RF29BB8600QL',
      serial_number: '0BZ94BBT500812', location: 'Kitchen', retailer: 'Home Depot',
      purchase_date: ago(390), price_cents: 289900, life_months: 132,
      coverages: (p) => [
        { label: 'Manufacturer warranty', provider: 'Samsung', starts_on: p, expires_on: after(12, p) },
        { label: 'Sealed system and compressor', provider: 'Samsung', starts_on: p, expires_on: after(120, p) },
        { label: 'Home Depot Protection Plan', provider: 'Allstate', starts_on: after(12, p), expires_on: after(48, p) },
      ],
    },
    {
      name: 'Canon EOS R6 Mark II', category: 'Photography', brand: 'Canon', model: 'EOS R6 II',
      serial_number: '102031004587', location: 'Office', retailer: 'B&H Photo',
      purchase_date: ago(395), price_cents: 249900, life_months: 60,
      coverages: (p) => [
        { label: 'Canon USA limited warranty', provider: 'Canon', starts_on: p, expires_on: after(12, p) },
      ],
    },
    {
      name: 'Trek FX 3 Disc', category: 'Outdoor', brand: 'Trek', model: 'FX 3 Disc, Medium',
      serial_number: 'WTU281C4471K', location: 'Garage', retailer: 'Trek Bicycle Store',
      purchase_date: ago(210), price_cents: 109999, life_months: null,
      notes: 'Frame registered with Trek. Free tune-ups for 1 year.',
      coverages: (p) => [
        { label: 'Lifetime frame warranty', provider: 'Trek', starts_on: p, expires_on: after(600, p) },
        { label: 'Components', provider: 'Trek', starts_on: p, expires_on: after(12, p) },
      ],
    },
    {
      name: 'Vitamix A3500', category: 'Kitchenware', brand: 'Vitamix', model: 'Ascent A3500',
      serial_number: '064992-A35-1182', location: 'Kitchen', retailer: 'Williams Sonoma',
      purchase_date: ago(1100), price_cents: 64995, life_months: 120,
      coverages: (p) => [
        { label: 'Full warranty', provider: 'Vitamix', starts_on: p, expires_on: after(120, p) },
      ],
    },
    {
      name: 'Sonos Arc Ultra', category: 'Electronics', brand: 'Sonos', model: 'Arc Ultra',
      serial_number: '', location: 'Living Room', retailer: 'Sonos',
      purchase_date: ago(40), price_cents: 99900, life_months: 72, coverages: () => [],
    },
    {
      name: 'Grandmother’s Oak Dresser', category: 'Furniture', brand: '', model: '',
      serial_number: '', location: 'Bedroom', retailer: '',
      purchase_date: null, price_cents: 85000, life_months: null,
      notes: 'Appraised in 2023. Keep appraisal letter with insurance documents.', coverages: () => [],
    },
  ];
  return items.map(({ coverages, ...item }) => ({ ...item, coverages: coverages(item.purchase_date) }));
}
