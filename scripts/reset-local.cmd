@echo off
docker compose down -v --remove-orphans
if exist data\generated rmdir /s /q data\generated
if exist artifacts\models rmdir /s /q artifacts\models
