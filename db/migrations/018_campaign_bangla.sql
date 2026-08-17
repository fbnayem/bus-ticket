-- Campaign copy in Bangla.
--
-- Every other passenger-facing string on the platform comes from the interface
-- catalogue, which has both languages. Offer titles do not: they are content,
-- written per campaign, and they were stored in exactly one language. A Bangla
-- reader browsing offers met four lines of English in the middle of an
-- otherwise Bangla page — and these are the lines that decide whether they buy.
--
-- The column is nullable on purpose. A campaign created without Bangla copy
-- falls back to `title` rather than showing an empty card, so an operator or a
-- referral reward can still be created with one string.

ALTER TABLE promo.campaigns ADD COLUMN IF NOT EXISTS title_bn text;

-- The seeded campaigns, written rather than transliterated. Figures stay in
-- Latin digits, the same rule the rest of the product follows: a discount is
-- read aloud over a phone line as often as it is read on a screen.
UPDATE promo.campaigns SET title_bn = v.bn
  FROM (VALUES
    ('EIDSAFAR',   'ঈদ সফর — 15% ছাড়'),
    ('EIDSAFAR2',  'ঈদ সফর — 12% ছাড়'),
    ('FIRST100',   'প্রথম 100 জন যাত্রী — 20% ছাড়'),
    ('NEWRIDER',   'স্বাগতম — 15% ছাড়'),
    ('BKASHPAY',   'বিকাশে দিলে — 8% ছাড়'),
    ('FIRSTRIDE',  'প্রথম যাত্রা — ৳100 ছাড়'),
    ('CTGWEEKEND', 'চট্টগ্রাম সাপ্তাহিক ছুটি — 10% ছাড়')
  ) AS v(code, bn)
 WHERE promo.campaigns.code = v.code;
