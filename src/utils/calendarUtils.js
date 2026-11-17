const icalGenerator = require('ical-generator');
const fs = require('fs-extra');
const path = require('path');
const moment = require('moment');
require('dotenv').config();

// Get reports directory from env or use default
const REPORTS_DIR = process.env.REPORTS_DIR || path.join(__dirname, '../../reports');

/**
 * Generate ICS file from calendar events
 * @param {Array} events Array of calendar events
 * @param {string} [outputPath] Where to write the file (default: reports/calendar_events_<timestamp>.ics)
 * @returns {Promise<{path: string, count: number}>} File written and number of events in it
 */
async function generateICSFile(events, outputPath) {
  // Ensure reports directory exists
  await fs.ensureDir(REPORTS_DIR);
  
  // Create calendar
  const calendar = icalGenerator.default({ name: 'EmailMaster Calendar' });
  
  // Add events to calendar (skipping any without a usable date)
  const isTime = (value) => /^\d{1,2}:\d{2}$/.test(String(value || '').trim());
  const seen = new Set(); // the same event often appears in several emails
  let count = 0;
  events.forEach(event => {
    if (!event || !/^\d{4}-\d{2}-\d{2}$/.test(String(event.date || '').trim())) return;
    const time = isTime(event.time) ? event.time.trim() : null;
    const endTime = time && isTime(event.endTime) ? event.endTime.trim() : null;
    const key = `${String(event.title || '').trim().toLowerCase()}|${event.date}|${time || ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    // All-day dates are written in UTC by ical-generator, so build them at UTC
    // midnight; timed events stay in local wall-clock time (floating).
    const startDate = time
      ? moment(`${event.date} ${time}`, 'YYYY-MM-DD HH:mm', true)
      : moment.utc(event.date, 'YYYY-MM-DD', true);
    if (!startDate.isValid()) return;
    let endDate;
    
    if (endTime) {
      endDate = moment(`${event.date} ${endTime}`, 'YYYY-MM-DD HH:mm');
    } else if (time) {
      // Default to 1 hour duration if only start time is provided
      endDate = moment(startDate).add(1, 'hour');
    } else {
      // All-day event
      endDate = startDate.clone().add(1, 'day');
    }
    
    calendar.createEvent({
      // moment objects (not Date): ical-generator only honours `floating` for these
      start: startDate,
      end: endDate,
      summary: event.title || 'Event',
      description: event.description || '',
      allDay: !time,
      // Wall-clock time with no timezone: avoids all-day events shifting a
      // day when the local time is converted to UTC
      floating: true
    });
    count++;
  });
  
  // Generate filename with timestamp
  const timestamp = moment().format('YYYY-MM-DD_HH-mm-ss');
  const filename = `calendar_events_${timestamp}.ics`;
  const filePath = outputPath || path.join(REPORTS_DIR, filename);
  
  // Write ICS file
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, calendar.toString());
  
  return { path: filePath, count };
}

/**
 * Generate plain text calendar snippet
 * @param {Array} events Array of calendar events
 * @returns {string} Plain text calendar snippet
 */
function generatePlainTextCalendar(events) {
  if (events.length === 0) {
    return 'No calendar events found.';
  }
  
  let text = 'Calendar Events:\n\n';
  
  events.forEach((event, index) => {
    text += `${index + 1}. ${event.title}\n`;
    text += `   Date: ${event.date}\n`;
    
    if (event.time) {
      text += `   Time: ${event.time}`;
      if (event.endTime) {
        text += ` - ${event.endTime}`;
      }
      text += '\n';
    } else {
      text += '   All day event\n';
    }
    
    if (event.description) {
      text += `   Description: ${event.description}\n`;
    }
    
    text += '\n';
  });
  
  text += 'To add these events to your calendar, use the generated ICS file or copy the details above.';
  
  return text;
}

module.exports = {
  generateICSFile,
  generatePlainTextCalendar
};
