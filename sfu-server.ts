import { Server } from 'socket.io';
import express from 'express';
import http from 'http';
import { Kafka } from 'kafkajs';

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

// Kafka 설정
const kafka = new Kafka({
  clientId: 'sfu-server',
  brokers: process.env.KAFKA_BROKERS ? process.env.KAFKA_BROKERS.split(',') : ['localhost:9092'],
});
const kafkaConsumer = kafka.consumer({ groupId: 'sfu-group' });

(async () => {
  await kafkaConsumer.connect();
  await kafkaConsumer.subscribe({ topic: 'sfu_commands', fromBeginning: true });
  
  await kafkaConsumer.run({
    eachMessage: async ({ message }) => {
      if (message.value) {
        const command = JSON.parse(message.value.toString());
        handleCommand(command);
      }
    },
  });
  console.log('SFU Kafka consumer running');
})();

const handleCommand = (command : any) => {
  switch (command.type) {
    case 'joinRoom':
      console.log(`SFU: ${command.user.userName} joined room ${command.room.roomId}`);
      io.in(command.room.roomId).emit('user-joined', command);
      break;
    case 'disconnect':
      console.log(`SFU: User disconnected ${command.socketId}`);
      io.emit('user-disconnected', { socketId: command.socketId });
      break;
    default:
      console.log('Unknown command:', command);
  }
};

io.on('connection', (socket) => {
  console.log(`SFU 연결됨: ${socket.id}`);
  
  socket.on('relay-offer', (data) => {
    socket.to(data.room).emit('relay-offer', { sender: socket.id, offer: data.offer });
  });
  socket.on('relay-answer', (data) => {
    socket.to(data.room).emit('relay-answer', { sender: socket.id, answer: data.answer });
  });
  socket.on('relay-candidate', (data) => {
    socket.to(data.room).emit('relay-candidate', { sender: socket.id, candidate: data.candidate });
  });
  
  socket.on('disconnect', () => {
    console.log(`SFU 사용자 연결 종료됨: ${socket.id}`);
  });
});

app.use(express.json());
server.listen(process.env.SFU_PORT || 8500, () => {
  console.log(`SFU 서버가 포트 ${process.env.SFU_PORT || 8500}에서 실행 중`);
});