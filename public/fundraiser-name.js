// Academy titles are display text. Registration, signatures and certificate
// names keep their original values in their respective records.
function titledName(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) return 'Fundraiser';
  const name = value.trim().replace(/\s+/gu, ' ');
  if (!name || /^fundraiser$/iu.test(name)) return 'Fundraiser';
  const base = name.replace(/(?:\s+fundraiser)+$/iu, '').trim();
  return base ? `${base} Fundraiser` : 'Fundraiser';
}

/** Use only the registered first-name field for private Academy titles. */
export function fundraiserName(userOrFirstName) {
  const firstName = typeof userOrFirstName === 'string' ? userOrFirstName : userOrFirstName?.firstName;
  return titledName(firstName);
}

/** Public rankings continue to use the alias explicitly chosen for sharing. */
export function publicFundraiserName(alias) {
  return titledName(alias);
}
