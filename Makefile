LDFLAGS = -lwiringPi

ALL: waterfuse

install: ALL
	sudo systemctl stop waterfuse && sudo cp waterfuse /usr/local/bin && sudo systemctl start waterfuse
