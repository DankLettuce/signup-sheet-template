// Shared by the API (functions/api) and scripts/configure.mjs.
// Event details the organizer can edit (Organizer mode -> "Event details"). max = characters; one_of = allowed values.
export const SETTINGS = {
  event_name: { max: 60, def: 'Class Party' },
  teacher: { max: 60, def: '' },
  class_name: { max: 60, def: '' },
  school: { max: 60, def: '' },
  party_date: { max: 60, def: 'TBD' },
  party_time: { max: 60, def: 'TBD' },
  intro: { max: 300, def: '', multiline: true },
  banner: { one_of: ['animated', 'still', 'none'], def: 'animated' },
  organizer_name: { max: 60, def: '' },
  organizer_contact: { max: 100, def: '' },
};
export const ITEM_LIMITS = { itemName: 60, spotsMax: 99, maxItems: 40 };
