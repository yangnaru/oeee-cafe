# Collaborative Drawing Feature

A real-time collaborative drawing application integrated into oeee-cafe.

## URLs

- **`/collaborate`** - Landing page for collaborative drawing
- **`/collaborate/room?room=<room_id>`** - Join a specific drawing room
- **`/collaborate/room/new`** - Create a new private drawing room (requires login)
- **`/collaborate/ws`** - WebSocket endpoint for drawing protocol

## Features

### Real-time Collaboration
- Multiple users can draw simultaneously
- See other users' cursors and strokes in real-time
- User presence indicators
- Built-in chat system

### Drawing Tools
- Brush with adjustable size (1-50px) and opacity (0-100%)
- Color picker with preset palette
- Eraser tool
- Color picker/eyedropper tool
- Pan tool for canvas navigation

### Canvas Management
- Zoom controls (10%-500%)
- Fit to screen
- Save canvas as PNG
- Clear canvas (with confirmation)
- Persistent canvas state (survives browser refresh/server restart)

### Room Management
- Public rooms (accessible by room ID)
- Private rooms (created by authenticated users)
- Room persistence in database
- User activity tracking

## Database Schema

### Tables Created
- `collaborative_sessions` - Room metadata and settings
- `collaborative_messages` - All drawing commands for replay
- `collaborative_session_users` - User presence and activity

## Technical Implementation

### Frontend
- **CSS**: `/static/canvas-client.css` - Modern, responsive UI
- **JavaScript**: `/static/canvas-client.js` - Full-featured drawing client
- **Templates**: 
  - `canvas_index.jinja` - Landing page
  - `canvas_room.jinja` - Drawing room

### Backend
- **WebSocket Handler**: `canvas.rs` - Binary protocol implementation
- **Room Handlers**: `canvas_room.rs` - HTTP endpoints
- **Database Models**: `canvas_session.rs` - Persistence layer

### Protocol
Uses a simplified binary drawing protocol:
- Header: 4 bytes length + 1 byte type + 1 byte reserved + 2 bytes user ID
- Message types: 64-66 (drawing commands), 200 (user list)
- Persistent message storage with sequence numbers

## Usage Examples

### Join Public Room
```
GET /collaborate/room?room=public
```

### Create Private Room
```
GET /collaborate/room/new
```

### Custom Room Settings
```
GET /collaborate/room?room=my_room&width=1200&height=800
```

## Mobile Support
- Touch events for drawing
- Responsive layout for mobile devices
- Optimized canvas performance

## Integration with oeee-cafe
- Uses existing user authentication system
- Follows site design patterns
- Integrated navigation link
- Database integration with existing schema